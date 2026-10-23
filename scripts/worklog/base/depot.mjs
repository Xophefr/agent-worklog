// Dépôt de données du mode base : la SEULE voie d'écriture dans les tables du BFF.
//
// ecrire(projet, auteur, fn) : transaction ; verrou du projet (SELECT … FOR UPDATE) ; lecture des
// données sous la forme de chantiers.json ; fn (une opération pure : operations.mjs, applyPatch,
// applySession…) sur une copie ; comparaison avant/après champ par champ ; écriture des seuls
// objets changés ; une ligne d'historique par champ changé, dans la même transaction. Deux
// écritures sur un même projet passent donc l'une après l'autre, et aucune n'échappe à l'historique.
// Options : `uid` (une opération déjà appliquée n'écrit rien : réponse `deja`) et `garde`
// ({ version } ou { depuis } : refus 409 si un autre auteur a modifié le même champ entre-temps).
import { createHash, randomBytes } from "node:crypto";

export class ErreurDepot extends Error {
  constructor(code, message, details) { super(message); this.code = code; if (details) this.details = details; }
}

const json = (v) => JSON.stringify(v ?? null);
const lireJson = (t, d) => { try { return t == null ? d : JSON.parse(t); } catch { return d; } };
const enTexte = (v) => (v == null ? null : typeof v === "string" ? v : JSON.stringify(v));
const maintenant = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const empreinte = (t) => createHash("sha256").update(String(t)).digest("hex");

async function charger(q, projetId) {
  const pr = (await q("SELECT id, nom, ui, reglages, textes FROM wl_projets WHERE id = ?", [projetId]))[0];
  if (!pr) throw new ErreurDepot(404, `projet inconnu : ${projetId}`);
  const docs = async (table) => (await q(`SELECT donnees FROM ${table} WHERE projet_id = ? ORDER BY ordre`, [projetId])).map((r) => JSON.parse(r.donnees));
  const textes = lireJson(pr.textes, {});
  const der = (await q("SELECT n, quand FROM wl_historique WHERE projet_id = ? ORDER BY n DESC LIMIT 1", [projetId]))[0];
  const code = (await q("SELECT stats FROM wl_code WHERE projet_id = ?", [projetId]))[0];
  const { consigne = "", ...autres } = textes;
  return {
    meta: { projet: pr.nom, ui: lireJson(pr.ui, {}), version: der ? Number(der.n) : 0, edition: der ? der.quand : null, mode: "base" },
    chantiers: await docs("wl_chantiers"),
    items: await docs("wl_taches"),
    journal: { consigne, entrees: (await q("SELECT donnees FROM wl_journal WHERE projet_id = ? ORDER BY n", [projetId])).map((r) => JSON.parse(r.donnees)) },
    reglages: lireJson(pr.reglages, {}),
    textes: autres,
    specs: (await q("SELECT chemin, texte FROM wl_specs WHERE projet_id = ? ORDER BY chemin", [projetId])).map((r) => ({ chemin: r.chemin, texte: r.texte })),
    code: code ? lireJson(code.stats, null) : null,
  };
}

const versionDe = async (q, projetId) => Number((await q("SELECT MAX(n) AS n FROM wl_historique WHERE projet_id = ?", [projetId]))[0]?.n) || 0;

/**
 * Garde de conflit : pour chaque changement, la dernière ligne d'historique du même objet et du
 * même champ (ou de l'objet entier) écrite après `garde.version` (ou, à défaut, après
 * `garde.depuis`) par un autre auteur que cette session. Lue AVANT les lignes de cette écriture.
 */
async function conflitsDe(q, projetId, auteur, changements, garde) {
  const parVersion = garde.version != null;
  let borne;
  if (parVersion) {
    borne = Number(garde.version);
    if (!Number.isInteger(borne) || borne < 0) throw new ErreurDepot(400, "garde.version : entier attendu");
  } else {
    const t = Date.parse(String(garde.depuis));
    if (Number.isNaN(t)) throw new ErreurDepot(400, "garde.depuis : date ISO attendue");
    // Tronquée à la seconde, comme le client : une modification faite dans la seconde même de la garde
    // (`quand` > borne) ne compte pas comme postérieure.
    borne = new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  const conflits = [];
  for (const c of changements) {
    // Une création ou un retrait (champ « * ») heurte toute modification de l'objet.
    const champ = c.champ === "*" ? "" : " AND champ IN (?, '*')";
    const r = (await q(`SELECT auteur, quand FROM wl_historique WHERE projet_id = ? AND objet = ? AND objet_id = ?${champ} AND NOT (type_auteur = 'session' AND auteur = ?) AND ${parVersion ? "n" : "quand"} > ? ORDER BY n DESC LIMIT 1`,
      [projetId, c.objet, c.objet_id, ...(c.champ === "*" ? [] : [c.champ]), auteur.type === "session" ? auteur.nom : "", borne]))[0];
    if (r) conflits.push({ objet: c.objet, objet_id: c.objet_id, champ: c.champ, voulu: c.apres, enBase: c.avant, auteur: r.auteur, quand: r.quand });
  }
  return conflits;
}

/** Le corps d'une écriture, dans une transaction déjà ouverte (`q` = sa requête). */
async function ecrireDans(q, projetId, auteur, fn, { uid, garde } = {}) {
  if (!(await q("SELECT id FROM wl_projets WHERE id = ? FOR UPDATE", [projetId])).length) throw new ErreurDepot(404, `projet inconnu : ${projetId}`);
  // Opération déjà appliquée (rejeu d'une file d'attente) : rien n'est écrit une seconde fois.
  if (uid != null) {
    const vu = (await q("SELECT projet_id FROM wl_operations WHERE uid = ?", [uid]))[0];
    if (vu && vu.projet_id !== projetId) throw new ErreurDepot(400, `uid déjà employé pour un autre projet : ${uid}`);
    if (vu) return { deja: true, resultat: null, version: await versionDe(q, projetId), changements: [] };
  }
  const avant = await charger(q, projetId);
  const apres = structuredClone(avant);
  const resultat = await fn(apres);
  const changements = [];
  const noter = (objet, objet_id, champ, a, b) => changements.push({ objet, objet_id, champ, avant: a ?? null, apres: b ?? null });

  // Chantiers et tâches : création, modification champ par champ, retrait.
  for (const [table, objet, l0, l1] of [["wl_chantiers", "chantier", avant.chantiers, apres.chantiers], ["wl_taches", "tache", avant.items, apres.items]]) {
    const vieux = new Map(l0.map((x) => [x.id, x]));
    let ordre = l0.length;
    for (const x of l1) {
      const o = vieux.get(x.id);
      if (!o) {
        await q(`INSERT INTO ${table} (projet_id, id, ordre, donnees) VALUES (?, ?, ?, ?)`, [projetId, x.id, ++ordre, JSON.stringify(x)]);
        noter(objet, x.id, "*", null, x);
        continue;
      }
      vieux.delete(x.id);
      const champs = [...new Set([...Object.keys(o), ...Object.keys(x)])].filter((k) => json(o[k]) !== json(x[k]));
      if (!champs.length) continue;
      await q(`UPDATE ${table} SET donnees = ? WHERE projet_id = ? AND id = ?`, [JSON.stringify(x), projetId, x.id]);
      for (const k of champs) noter(objet, x.id, k, o[k], x[k]);
    }
    for (const o of vieux.values()) {
      await q(`DELETE FROM ${table} WHERE projet_id = ? AND id = ?`, [projetId, o.id]);
      noter(objet, o.id, "*", o, null);
    }
  }

  // Journal : ajout seul.
  for (const e of apres.journal.entrees.slice(avant.journal.entrees.length)) {
    await q("INSERT INTO wl_journal (projet_id, donnees) VALUES (?, ?)", [projetId, JSON.stringify(e)]);
    noter("journal", `${e.date || ""} ${e.session || ""}`.trim(), "*", null, e);
  }

  // Projet : nom, couleurs, réglages, textes (dont la consigne du journal).
  const t0 = { ...avant.textes, consigne: avant.journal.consigne };
  const t1 = { ...apres.textes, consigne: apres.journal.consigne };
  for (const [champ, col, a, b] of [["nom", "nom", avant.meta.projet, apres.meta.projet], ["ui", "ui", avant.meta.ui, apres.meta.ui], ["reglages", "reglages", avant.reglages, apres.reglages], ["textes", "textes", t0, t1]]) {
    if (json(a) === json(b)) continue;
    await q(`UPDATE wl_projets SET ${col} = ? WHERE id = ?`, [champ === "nom" ? b : JSON.stringify(b), projetId]);
    noter("projet", projetId, champ, a, b);
  }

  // Specs et relevé de code, envoyés par la commande du projet.
  const sp0 = new Map(avant.specs.map((s) => [s.chemin, s.texte]));
  for (const s of apres.specs) {
    if (sp0.get(s.chemin) === s.texte) continue;
    if (sp0.has(s.chemin)) await q("UPDATE wl_specs SET texte = ? WHERE projet_id = ? AND chemin = ?", [s.texte, projetId, s.chemin]);
    else await q("INSERT INTO wl_specs (projet_id, chemin, texte) VALUES (?, ?, ?)", [projetId, s.chemin, s.texte]);
    noter("spec", s.chemin, "texte", sp0.get(s.chemin), s.texte);
  }
  if (json(avant.code) !== json(apres.code)) {
    await q("DELETE FROM wl_code WHERE projet_id = ?", [projetId]);
    if (apres.code) await q("INSERT INTO wl_code (projet_id, stats) VALUES (?, ?)", [projetId, JSON.stringify(apres.code)]);
    noter("code", projetId, "stats", null, "relevé reçu");
  }

  if (garde && (garde.version != null || garde.depuis != null)) {
    const conflits = await conflitsDe(q, projetId, auteur, changements, garde);
    if (conflits.length) throw new ErreurDepot(409, "conflit : modifié entre-temps", { conflits });
  }

  // Historique : l'auteur précédent de chaque champ (pour dire à une session ce qu'elle remplace), puis la ligne.
  const quand = maintenant();
  for (const c of changements) {
    if (c.champ !== "*") {
      const r = (await q("SELECT auteur, type_auteur, quand FROM wl_historique WHERE projet_id = ? AND objet = ? AND objet_id = ? AND champ IN (?, '*') ORDER BY n DESC LIMIT 1", [projetId, c.objet, c.objet_id, c.champ]))[0];
      if (r) c.auteurAvant = { nom: r.auteur, type: r.type_auteur, quand: r.quand };
    }
    await q("INSERT INTO wl_historique (projet_id, objet, objet_id, champ, avant, apres, auteur, type_auteur, quand) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [projetId, c.objet, c.objet_id, c.champ, enTexte(c.avant), enTexte(c.apres), auteur.nom, auteur.type, quand]);
  }
  if (uid != null) await q("INSERT INTO wl_operations (uid, projet_id, quand) VALUES (?, ?, ?)", [uid, projetId, quand]);
  return { resultat, version: await versionDe(q, projetId), changements };
}

const ajoutProjet = async (q, { id, nom, ui = {}, reglages = {}, textes = {} }, auteur) => {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(String(id || ""))) throw new ErreurDepot(400, `id de projet invalide : ${id} (minuscules, chiffres, tirets)`);
  if ((await q("SELECT id FROM wl_projets WHERE id = ?", [id])).length) throw new ErreurDepot(409, `${id} existe déjà en base`);
  await q("INSERT INTO wl_projets (id, nom, ui, reglages, textes, cree_le) VALUES (?, ?, ?, ?, ?, ?)", [id, nom, JSON.stringify(ui), JSON.stringify(reglages), JSON.stringify(textes), maintenant()]);
  await q("INSERT INTO wl_historique (projet_id, objet, objet_id, champ, avant, apres, auteur, type_auteur, quand) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, "projet", id, "*", null, JSON.stringify({ id, nom }), auteur.nom, auteur.type, maintenant()]);
};

/**
 * Import d'un projet du mode fichiers, en UNE transaction. Un projet déjà en base est refusé,
 * sauf `remplacer` : ses données sont alors remplacées par comparaison, donc chaque changement
 * (et chaque objet disparu) est tracé dans l'historique.
 */
export async function importer(depot, { id, nom, ui = {}, data, journal = { consigne: "", entrees: [] }, textes = {}, specs = [] }, auteur, { remplacer = false } = {}) {
  return depot.base.transaction(async (tx) => {
    const existe = (await tx.requete("SELECT id FROM wl_projets WHERE id = ?", [id])).length > 0;
    if (existe && !remplacer) throw new ErreurDepot(409, `${id} existe déjà en base (--remplacer pour l'écraser)`);
    if (!existe) await ajoutProjet(tx.requete, { id, nom, ui }, auteur);
    return ecrireDans(tx.requete, id, auteur, (d) => {
      d.meta.projet = nom;
      d.meta.ui = ui;
      d.chantiers = structuredClone(data.chantiers || []);
      d.items = structuredClone(data.items || []);
      // Journal : ajout seul ; un remplacement n'efface pas ce qui y est déjà.
      d.journal.consigne = journal.consigne || "";
      d.journal.entrees.push(...journal.entrees.slice(d.journal.entrees.length));
      d.textes = { ...d.textes, ...textes };
      for (const s of specs) { const k = d.specs.findIndex((x) => x.chemin === s.chemin); if (k >= 0) d.specs[k] = s; else d.specs.push(s); }
    });
  });
}

export function creerDepot(base) {
  const q0 = base.requete;
  const ecrire = (projetId, auteur, fn, opts = {}) => base.transaction((tx) => ecrireDans(tx.requete, projetId, auteur, fn, opts));

  return {
    base,
    ecrire,
    lire: (projetId) => charger(q0, projetId),
    async projets() { return (await q0("SELECT id, nom FROM wl_projets ORDER BY id")).map((r) => ({ id: r.id, nom: r.nom })); },

    creerProjet: (p, auteur) => base.transaction((tx) => ajoutProjet(tx.requete, p, auteur)),

    async historique(projetId, objet, objetId) {
      return q0("SELECT n, objet, objet_id, champ, avant, apres, auteur, type_auteur, quand FROM wl_historique WHERE projet_id = ? AND objet = ? AND objet_id = ? ORDER BY n DESC", [projetId, objet, objetId]);
    },

    /** Jeton neuf, rendu une seule fois ; seule son empreinte est gardée. projetId null = jeton d'interface. */
    async creerJeton(projetId, nom) {
      const jeton = randomBytes(32).toString("base64url");
      await q0("INSERT INTO wl_jetons (empreinte, projet_id, nom, cree_le) VALUES (?, ?, ?, ?)", [empreinte(jeton), projetId, nom, maintenant()]);
      return jeton;
    },
    async verifierJeton(jeton) {
      if (!jeton) return null;
      const r = (await q0("SELECT projet_id FROM wl_jetons WHERE empreinte = ?", [empreinte(jeton)]))[0];
      return r ? { projetId: r.projet_id ?? null } : null;
    },
  };
}
