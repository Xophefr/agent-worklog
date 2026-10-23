// Commande d'un projet en mode base : `npm run chantiers …` parle au BFF (HTTP, `fetch` de Node,
// aucune dépendance) au lieu de lire et d'écrire les .md du dépôt. Chargé par
// chantiers-tracker.mjs quand tracker.config.json dit "mode": "base", ou pour `--importer`.
//
//   npm run chantiers                                   # envoie les specs, résumé, incohérences
//   npm run chantiers -- --check | --strict
//   npm run chantiers -- --session s --statut ID=x --suivi "ID=texte" --lot ID=n --chantier ID=CH-xx
//   npm run chantiers -- voir CH-xx | taches [CH-xx]
//   npm run chantiers -- --session s chantier ajouter --titre … [--etat --prochaine --decisions --doc --priorite --id]
//   npm run chantiers -- --session s chantier maj CH-xx --champ valeur…
//   npm run chantiers -- --session s chantier clore CH-xx --preuve … --reste … [--abandon]
//   npm run chantiers -- --session s tache ajouter CH-xx --titre … [--constat --attendu --domaine --priorite --decision --id]
//   npm run chantiers -- --session s tache maj ID --champ valeur…
//   npm run chantiers -- --session s journal "texte" [--chantier CH-xx --commits … --docs …]
//   npm run chantiers -- --importer [--bff <url>] [--id <id>] [--remplacer] [--retirer-md]
//   npm run chantiers -- --exporter [--remplacer]
//   npm run chantiers -- attente                                  # file du poste et opérations mises de côté
//   npm run chantiers -- --session s attente appliquer <uid>      # renvoie l'opération sans garde, signée s
//   npm run chantiers -- attente abandonner <uid>
//
// Hors ligne (BFF injoignable) : une écriture attend sur le poste (~/.agent-worklog/attente/, jamais de jeton),
// code de sortie 75, et se rejoue dans l'ordre à la commande suivante ; un conflit est mis de côté (CONFLIT …).
// Une lecture montre la dernière copie du poste (code 75). Une création hors ligne demande --id.
//
// Jetons, jamais dans le dépôt : ~/.agent-worklog/jetons.json { "<origine du BFF>|<projet>": "<jeton>" } (ou
// WORKLOG_TOKEN) ; l'import se fait avec le jeton d'interface de ~/.agent-worklog/bff-lies.json.
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { at, CONFIG_FILE } from "./config.mjs";
import { construire, incoherences, pairs, parseJournal, specRe } from "./chantiers-tracker.mjs";
import { abandonner, avecVerrou, conflitsEnAttente, enAttente, enfiler, garderCopie, lireCopie, mettreDeCote, objetsTouches, retirer } from "./attente.mjs";

const maison = () => process.env.AGENT_WORKLOG_HOME || join(homedir(), ".agent-worklog");
const lireJson = (f, d) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };
const posix = (p) => p.replaceAll("\\", "/");
const jour = () => new Date().toLocaleDateString("en-CA");
// Un BFF qui accepte la connexion sans jamais répondre (tunnel bloqué) ne doit pas figer une session.
const delai = () => Number(process.env.WORKLOG_DELAI_BFF) || 15000;
const GEL = "> Gelé le";

class ErreurClient extends Error { constructor(code, message) { super(message); this.code = code; } }

// Un jeton n'est envoyé qu'au BFF pour lequel il a été émis : sa clé porte l'origine du BFF. Une
// adresse changée dans tracker.config.json (un fichier du dépôt) ne trouve donc aucun jeton.
const cleJeton = (bff, projet) => `${new URL(bff).origin}|${projet}`;
const fichierJetons = () => join(maison(), "jetons.json");
const jetonDe = (cfg) => process.env.WORKLOG_TOKEN || lireJson(fichierJetons(), {})[cleJeton(cfg.bff, cfg.projetBase)];
function garderJeton(bff, projet, jeton) {
  const f = fichierJetons();
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify({ ...lireJson(f, {}), [cleJeton(bff, projet)]: jeton }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try { chmodSync(f, 0o600); } catch { /* Windows : droits du profil */ }
  return f;
}
/** Un chemin du réglage (fichier du dépôt) qui sortirait du projet est refusé. */
function dans(ROOT, p) {
  const r = resolve(p);
  if (r !== resolve(ROOT) && !r.startsWith(resolve(ROOT) + sep)) throw new ErreurClient(2, `chemin hors du projet refusé : ${p}`);
  return r;
}

// Connexion jamais établie : la demande n'est pas partie. Tout autre silence (délai, coupure) la laisse incertaine.
// Un tunnel levé devant un BFF arrêté accepte puis coupe (ECONNRESET) : c'est un silence incertain, pas un refus.
const REFUS = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"]);
const refusee = (e) => [e?.cause, ...(e?.cause?.errors || [])].some((c) => REFUS.has(c?.code));

// Erreur levée : `injoignable` (réseau, délai : aucune réponse ; `incertain` si la demande a pu arriver)
// ou `statut` (code HTTP), `raison` (texte du BFF) et `conflits` (refus 409).
async function appel(url, jeton, chemin, corps) {
  let r;
  try {
    r = await fetch(url.replace(/\/+$/, "") + chemin, {
      signal: AbortSignal.timeout(delai()),
      method: corps === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${jeton}`, "Content-Type": "application/json" },
      body: corps === undefined ? undefined : JSON.stringify(corps),
    });
  } catch (e) {
    throw Object.assign(new ErreurClient(1, `BFF injoignable (${url}) : rien n'est écrit. Le BFF tourne-t-il (npm run bff), le tunnel est-il ouvert ?`), { injoignable: true, incertain: !refusee(e) });
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw Object.assign(new ErreurClient(1, `${j.error || `HTTP ${r.status}`} -- rien n'est écrit`), { statut: r.status, raison: j.error || `HTTP ${r.status}`, conflits: j.conflits || [] });
  return j;
}

// Refus qui tiennent au jeton, à l'adresse, au projet ou à la charge du BFF, pas à l'opération : le rejeu s'arrête.
const ARRET = new Set([401, 403, 404, 408, 429]);

const valeur = (x) => (typeof x === "string" ? x : JSON.stringify(x) ?? "").slice(0, 60);
const date = (q) => String(q || "").slice(0, 16).replace("T", " ");
// Ids touchés par une opération. « session » porte des paires [id, valeur] : ramenées en { id: valeur }.
const enObjet = (v) => (Array.isArray(v) ? Object.fromEntries(v.filter(Array.isArray)) : v);
const objets = (op, args) => objetsTouches(op, op === "session" && args
  ? Object.fromEntries(Object.entries(args).map(([k, v]) => [k, enObjet(v)])) : args).filter(Boolean);

// Une écriture gardée sur le poste : ce n'est pas une erreur, mais rien n'est encore en base (code 75).
class EnAttente extends ErreurClient {
  constructor(raison, n) { super(75, `EN ATTENTE : ${raison}, écriture gardée sur ce poste (${n} en attente) — PAS encore en base`); }
}

/** Opérations mises de côté, une ligne par conflit relevé : à trancher avec `attente appliquer|abandonner <uid>`. */
function imprimerConflits(liste) {
  for (const c of liste) {
    if (c.illisible) { console.log(`CONFLIT ${c.uid} illisible : ${c.raison} (seulement : attente abandonner ${c.uid})`); continue; }
    if (!(c.conflits || []).length) { console.log(`CONFLIT ${c.uid} ${c.op} ${objets(c.op, c.args).join(", ") || "—"} : ${c.raison}`); continue; }
    for (const k of c.conflits) console.log(`CONFLIT ${c.uid} ${c.op} ${k.objet_id} ${k.champ} : voulu « ${valeur(k.voulu)} », en base « ${valeur(k.enBase)} » (${k.auteur}, ${date(k.quand)})`);
  }
  if (liste.length) console.log("  à trancher : npm run chantiers -- --session <s> attente appliquer <uid>   |   attente abandonner <uid>");
}

// Options « --nom valeur » (ou drapeau seul) et mots (verbes, ids, texte du journal).
function lireArgs(argv) {
  const opts = {}, mots = [], multi = { statut: [], suivi: [], lot: [], chantier: [] };
  const DRAPEAUX = new Set(["check", "strict", "importer", "exporter", "remplacer", "retirer-md", "abandon", "decision"]);
  for (let k = 0; k < argv.length; k++) {
    const m = argv[k].match(/^--([a-z-]+)(?:=(.*))?$/s);
    if (!m) { mots.push(argv[k]); continue; }
    const [, nom, v] = m;
    if (nom === "root") { if (v === undefined) k++; continue; }
    const val = v !== undefined ? v : DRAPEAUX.has(nom) && (argv[k + 1] === undefined || argv[k + 1].startsWith("--") || !["oui", "non"].includes(argv[k + 1])) ? true : argv[++k];
    if (nom in multi) multi[nom].push(val);
    opts[nom] = val;
  }
  return { opts, mots, multi };
}

const CHAMPS = { titre: "titre", etat: "etat", prochaine: "prochaine_action", decisions: "decisions", doc: "doc", priorite: "priorite", note: "note",
  constat: "constat", attendu: "attendu", domaine: "domaine", statut: "statut", decision: "decision", chantier: "chantier", lot: "lot", id: "id" };
function champs(opts, permis) {
  const out = {};
  for (const [k, v] of Object.entries(opts)) {
    if (!(k in CHAMPS) || !permis.includes(CHAMPS[k])) continue;
    out[CHAMPS[k]] = CHAMPS[k] === "decision" ? v === true || v === "oui" : v;
  }
  return out;
}

function imprimerChangements(changements, session) {
  for (const c of changements) {
    if (c.champ === "*") { console.log(`  ${c.objet} ${c.objet_id} : ${c.avant ? "retiré" : "créé"}`); continue; }
    const v = (x) => (typeof x === "string" ? x : JSON.stringify(x)).slice(0, 60);
    // L'auteur précédent n'est dit que si ce n'est pas cette session : c'est lui que l'on remplace.
    const qui = c.auteurAvant && !(c.auteurAvant.type === "session" && c.auteurAvant.nom === session) ? c.auteurAvant : null;
    console.log(`  ${c.objet_id} ${c.champ} : était « ${v(c.avant)} »${qui ? ` (${qui.nom}, ${String(qui.quand || "").slice(0, 16).replace("T", " ")})` : ""}, devient « ${v(c.apres)} »`);
  }
}

function voir(d, id) {
  const c = d.chantiers.find((x) => x.id === id);
  if (!c) throw new ErreurClient(1, `chantier inconnu : ${id}`);
  console.log(`${c.id} · ${c.titre} — ${c.etat} (${c.colonne}) · ${c.priorite}`);
  for (const [l, v] of [["Prochaine action", c.prochaine_action], ["Décisions", c.decisions], ["Doc", c.doc], ["Note", c.note], ["Clos le", c.clos_le], ["Preuve", c.preuve], ["Reste", c.reste]]) if (v) console.log(`${l} : ${v}`);
  if ((c.lots || []).length) { console.log("Lots :"); for (const l of c.lots) console.log(`  ${l.id}. ${l.titre} (${(l.taches || []).join(", ") || "aucune tâche"})`); }
  taches(d, id);
  const j = d.journal.entrees.filter((e) => String(e.chantiers || "").includes(id) || e.chantiers === "tous").slice(-5);
  if (j.length) { console.log("Journal (dernières lignes) :"); for (const e of j) console.log(`  ${e.date} ${e.session} · ${e.texte}`); }
}
function taches(d, id) {
  const list = d.items.filter((i) => (!id || i.chantier === id) && !["fait", "abandonne"].includes(i.statut));
  console.log(`Tâches ouvertes${id ? ` de ${id}` : ""} : ${list.length}`);
  for (const i of list) console.log(`  ${i.id.padEnd(9)} ${i.priorite} ${i.statut.padEnd(10)} ${i.chantier || "—"}  ${i.titre}${i.decision ? "  [décision attendue]" : ""}`);
}

/** Les specs citées par la colonne « doc » des chantiers : { chemin, texte }. */
function specsDuDepot(ROOT, cfg, chantiers) {
  const re = specRe(cfg.specs);
  const out = [];
  for (const c of chantiers) {
    const m = String(c.doc || "").match(re);
    // La colonne « doc » vient du BFF : un nom de spec avec un chemin ou « .. » n'est pas lu.
    if (!m || /[\\/]|\.\./.test(m[1])) continue;
    const p = dans(at(ROOT, cfg, "specs"), join(at(ROOT, cfg, "specs"), m[1]));
    if (existsSync(p) && !out.some((s) => s.chemin === posix(relative(ROOT, p)))) out.push({ chemin: posix(relative(ROOT, p)), texte: readFileSync(p, "utf8") });
  }
  return out;
}

async function importerProjet(ROOT, cfg, opts) {
  const url = opts.bff || cfg.bff;
  if (!url) throw new ErreurClient(2, "--bff <url> attendu (adresse du BFF)");
  const lies = lireJson(join(maison(), "bff-lies.json"), {});
  let origine;
  try { origine = new URL(url).origin; } catch { throw new ErreurClient(2, `adresse de BFF invalide : ${url}`); }
  const ji = lies[url] || lies[origine];
  if (!ji) throw new ErreurClient(2, `pas de jeton d'interface pour ${url} : lier d'abord le BFF (node scripts/worklog/accueil.mjs lier-bff ${url} <jeton>, depuis agent-worklog)`);
  // Les chemins du réglage (fichier du dépôt) restent dans le projet : lus, puis peut-être retirés.
  dans(ROOT, at(ROOT, cfg, "chantiers"));
  dans(ROOT, at(ROOT, cfg, "backlog"));
  const { data, CHANTIERS_MD, BACKLOG_MD } = construire(ROOT, cfg);
  const id = opts.id || String(cfg.projet).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const chantiersMd = readFileSync(CHANTIERS_MD, "utf8");
  const { racine, backlog, ...ui } = cfg.ui;
  const r = await appel(url, ji, "/api/import", {
    id, nom: cfg.projet, ui, data: { chantiers: data.chantiers, items: data.items }, journal: parseJournal(chantiersMd),
    textes: { chantiersMd, backlogMd: readFileSync(BACKLOG_MD, "utf8") }, specs: specsDuDepot(ROOT, cfg, data.chantiers), remplacer: Boolean(opts.remplacer),
  });
  const fj = garderJeton(url, id, r.jeton);
  const fc = join(ROOT, CONFIG_FILE);
  writeFileSync(fc, JSON.stringify({ ...lireJson(fc, {}), mode: "base", bff: url, projetBase: id }, null, 4) + "\n", "utf8");
  console.log(`importé : ${data.chantiers.length} chantiers, ${data.items.length} tâches -> ${url} (projet ${id})`);
  console.log(`${CONFIG_FILE} passe en mode base ; jeton du projet enregistré dans ${posix(fj)} (hors du dépôt)`);
  if (opts["retirer-md"]) {
    await appel(url, r.jeton, `/api/p/${id}/operation`, { op: "reglages", args: { md: "retirer" }, session: "import" });
    for (const p of [CHANTIERS_MD, BACKLOG_MD]) { unlinkSync(p); console.log(`retiré ${posix(relative(ROOT, p))} (le suivi vit dans la base ; commit à faire)`); }
  }
  return 0;
}

/**
 * Les .md d'un projet importé : gelés (une ligne en tête, une fois), puis retirés si le réglage
 * du projet le demande. Seule une copie déjà gelée est retirée : une instruction du BFF ne peut
 * pas supprimer un fichier encore tenu à la main.
 */
function appliquerReglageMd(ROOT, cfg, reglages) {
  for (const p of [dans(ROOT, at(ROOT, cfg, "chantiers")), dans(ROOT, at(ROOT, cfg, "backlog"))]) {
    if (!existsSync(p)) continue;
    const t = readFileSync(p, "utf8");
    if (reglages.md === "retirer" && t.startsWith(GEL)) { unlinkSync(p); console.log(`retiré ${posix(relative(ROOT, p))} (réglage du projet ; commit à faire)`); continue; }
    if (!t.startsWith(GEL)) writeFileSync(p, `${GEL} ${jour()} : le suivi vit dans la base (agent-worklog, mode base) ; ce fichier n'est plus mis à jour.\n\n${t}`, "utf8");
  }
}

export async function mainBase(ROOT, cfg, argv) {
  try {
    const { opts, mots, multi } = lireArgs(argv);
    if (opts.importer) return await importerProjet(ROOT, cfg, opts);
    if (!cfg.bff || !cfg.projetBase) throw new ErreurClient(2, `mode base : "bff" et "projetBase" attendus dans ${CONFIG_FILE}`);
    const jeton = jetonDe(cfg);
    if (!jeton) throw new ErreurClient(2, `aucun jeton pour ${cleJeton(cfg.bff, cfg.projetBase)} (${posix(fichierJetons())} ou WORKLOG_TOKEN) : npm run bff -- jeton ${cfg.projetBase}, sur la machine du BFF`);
    const P = cfg.projetBase;
    const M = maison();
    const proj = { bff: cfg.bff, projet: P };
    const session = typeof opts.session === "string" ? opts.session.trim() : "";
    // horsLigne : le BFF s'est tu une fois, on ne le rappelle plus (chaque essai coûterait un délai) ;
    // copie : la sortie montre la copie du poste (code 75) ; arret : raison d'un rejeu interrompu.
    const etat = { horsLigne: false, verrouPris: false, arret: null, copie: null };

    // Seul le silence (réseau, délai) rend le BFF injoignable ; une réponse, même 5xx, n'en est pas un.
    const parler = async (chemin, corps) => {
      if (etat.horsLigne) throw Object.assign(new ErreurClient(1, `BFF injoignable (${cfg.bff}) : rien n'est écrit.`), { injoignable: true });
      try { return await appel(cfg.bff, jeton, chemin, corps); } catch (e) { if (e.injoignable) etat.horsLigne = true; throw e; }
    };
    const lire = async () => { const d = await parler(`/p/${P}/chantiers.json`); garderCopie(M, proj, d); return d; };
    // Lecture, ou la dernière copie du poste si le BFF est injoignable.
    const lireOuCopie = async () => {
      if (etat.copie) return etat.copie;
      try { return await lire(); } catch (e) {
        if (!e.injoignable) throw e;
        const c = lireCopie(M, proj);
        if (!c?.data) throw new ErreurClient(1, `serveur injoignable, aucune copie de ${P} sur ce poste`);
        console.log(`copie du ${new Date(c.quand).toLocaleString("fr-FR")} — serveur injoignable`);
        return (etat.copie = c.data);
      }
    };
    const fin = (code = 0) => (etat.copie && code === 0 ? 75 : code);

    // Jamais de champ à null (le BFF le refuse) : uid et garde ne partent que s'ils existent. La version de la
    // copie n'est pas avancée après une écriture : seule une lecture complète la fixe (sinon une garde hors
    // ligne cacherait le changement d'un autre auteur que la session n'a jamais vu).
    const envoyer = async ({ op, args, session: s, uid, garde }) => {
      const corps = { op, args, session: s };
      if (uid) corps.uid = uid;
      if (garde) corps.garde = garde;
      return parler(`/api/p/${P}/operation`, corps);
    };
    const direCree = (op, r) => {
      if (op !== "creerTache" && op !== "creerChantier") return;
      const mot = op === "creerTache" ? "créée" : "créé";
      console.log(r.resultat ? `${mot} ${r.resultat}` : `${mot} (déjà en base : son id est dans la liste, npm run chantiers -- taches)`);
    };

    // La file, dans l'ordre, sous verrou. Un objet déjà mis de côté entraîne les opérations suivantes qui le
    // touchent ; un refus de l'opération (400, 409, 422…) la met de côté ; le silence, un 5xx ou un refus qui
    // tient au jeton, à l'adresse ou au projet (401, 403, 404, 408, 429) arrête le rejeu : le reste attend.
    // `incertain` : uid de l'opération dont la demande a pu arriver sans réponse.
    const rejouer = async (rafraichir = () => {}) => {
      const resultats = new Map();
      const bloques = new Set(conflitsEnAttente(M, proj).filter((c) => !c.illisible).flatMap((c) => objets(c.op, c.args)));
      for (const o of enAttente(M, proj)) {
        const touches = objets(o.op, o.args);
        if (touches.some((x) => bloques.has(x))) { mettreDeCote(M, o.uid, { raison: "suit une opération mise de côté" }); continue; }
        try {
          const r = await envoyer(o);
          retirer(M, o.uid);
          rafraichir();
          resultats.set(o.uid, r);
          console.log(`rejoué ${o.op} (${o.session}, ${date(o.quand)})${r.deja ? " : déjà en base" : ""}`);
          imprimerChangements(r.changements || [], o.session);
          direCree(o.op, r);
        } catch (e) {
          if (e.injoignable) return { arret: "serveur injoignable", incertain: e.incertain ? o.uid : null, resultats };
          if (!e.statut || e.statut >= 500 || ARRET.has(e.statut)) return { arret: e.statut ? `le BFF a répondu ${e.statut} : ${e.raison}` : e.message, resultats };
          mettreDeCote(M, o.uid, { raison: e.statut === 409 ? "conflit" : e.raison, conflits: e.conflits });
          for (const x of touches) bloques.add(x);
          rafraichir();
        }
      }
      return { arret: null, resultats };
    };

    // Garde d'une écriture différée : la version de la copie si connue, sinon l'heure (à la seconde).
    // La copie est partagée par toutes les sessions et par l'accueil de ce poste : la version de la garde peut
    // venir de la lecture d'un autre lecteur, ce qui est plus strict que la spec (le changement d'un autre
    // auteur depuis cette lecture-là refuse l'écriture, même si cette session ne l'a jamais vu).
    const gardeHorsLigne = () => {
      const c = lireCopie(M, proj);
      return c?.version != null ? { version: c.version } : { depuis: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
    };
    const ecrire = async (op, args) => {
      if (!session) throw new ErreurClient(2, "--session est requis pour écrire (qui a fait quoi)");
      // Une création sans --id attend son id du BFF : impossible hors ligne.
      const sansId = (op === "creerTache" || op === "creerChantier") && !args.id;
      const refusSansId = (raison) => new ErreurClient(2, `${raison} : donnez --id pour créer hors ligne`);
      if (sansId && etat.horsLigne) throw refusSansId("serveur injoignable");
      const quoi = { bff: cfg.bff, projet: P, session, op, args, garde: gardeHorsLigne() };
      const res = etat.verrouPris ? null : await avecVerrou(M, async (rafraichir) => {
        if (!enAttente(M, proj).length) {
          // File vide : envoi direct, sans garde (comme en 2.0.0). L'opération est d'abord gardée avec son uid :
          // une réponse perdue (délai) se rejoue plus tard sans double écriture.
          const { uid } = enfiler(M, quoi);
          try { const r = await envoyer({ op, args, session, uid }); retirer(M, uid); return { r }; } catch (e) {
            if (e.injoignable && (!sansId || e.incertain)) return { uid, raison: "serveur injoignable", incertain: e.incertain };
            retirer(M, uid);
            throw e.injoignable ? refusSansId("serveur injoignable") : e;
          }
        }
        // File non vide : l'écriture la rejoint, pour garder l'ordre, puis la file est rejouée.
        const { uid } = enfiler(M, quoi);
        if (etat.horsLigne) return { uid, raison: "serveur injoignable" };
        const { arret, incertain, resultats } = await rejouer(rafraichir);
        return resultats.has(uid) ? { r: resultats.get(uid), rejoue: true } : { uid, raison: arret, incertain: incertain === uid };
      });
      if (res === null) {
        if (sansId) throw new ErreurClient(2, "un autre rejeu est en cours sur ce poste ; réessayez, ou donnez --id");
        enfiler(M, quoi);
        throw new EnAttente("un autre rejeu est en cours sur ce poste", enAttente(M, proj).length);
      }
      if (res.r) {
        if (!res.rejoue) { imprimerChangements(res.r.changements || [], session); direCree(op, res.r); }
        return res.r;
      }
      if (res.raison) {
        // Création sans --id : refusée si rien n'est parti ; gardée (même uid) si la demande a pu arriver.
        if (sansId && !res.incertain) { retirer(M, res.uid); throw refusSansId(res.raison); }
        if (sansId) throw new EnAttente("pas de réponse du serveur (délai dépassé ou connexion coupée) : la création a peut-être déjà été faite ; son id sera donné au rejeu, ou à retrouver avec taches", enAttente(M, proj).length);
        throw new EnAttente(res.raison, enAttente(M, proj).length);
      }
      imprimerConflits(conflitsEnAttente(M, proj).filter((c) => c.uid === res.uid));
      throw new ErreurClient(1, `écriture mise de côté (${res.uid}), rien n'est écrit : à trancher avec attente appliquer|abandonner`);
    };

    // Avant chaque commande : la file du poste d'abord, puis les conflits à trancher, en tête.
    if (enAttente(M, proj).length) {
      const r = await avecVerrou(M, rejouer);
      if (r === null) etat.verrouPris = true;
      else etat.arret = r.arret;
      const raison = etat.verrouPris ? "un autre rejeu est en cours sur ce poste" : etat.arret;
      if (raison) console.log(`${enAttente(M, proj).length} en attente (${raison})`);
    }
    const [verbe, sous, cible] = mots;
    if (verbe !== "attente") imprimerConflits(conflitsEnAttente(M, proj));

    if (verbe === "attente") {
      if (!sous) {
        const file = enAttente(M, proj), mis = conflitsEnAttente(M, proj);
        console.log(`En attente : ${file.length}`);
        for (const o of file) console.log(`  ${o.uid} ${o.op} ${objets(o.op, o.args).join(", ") || "—"} (${o.session}, ${date(o.quand)})`);
        console.log(`Mis de côté : ${mis.length}`);
        imprimerConflits(mis);
        return 0;
      }
      if (!["appliquer", "abandonner"].includes(sous) || !cible) throw new ErreurClient(2, "attente [appliquer <uid> --session s | abandonner <uid>]");
      const c = conflitsEnAttente(M, proj).find((x) => x.uid === cible);
      if (!c) throw new ErreurClient(1, `aucune opération mise de côté : ${cible}`);
      if (sous === "abandonner") { abandonner(M, c.uid); console.log(`abandonné ${c.uid}${c.op ? ` (${c.op})` : ""}`); return 0; }
      if (c.illisible) throw new ErreurClient(2, `${c.uid} est illisible : seulement attente abandonner ${c.uid}`);
      if (!session) throw new ErreurClient(2, "--session est requis pour appliquer (qui a tranché)");
      // Tranché par un humain : renvoyée sans garde, signée par la session qui tranche, avec un uid tiré du sien
      // (un nouvel essai après un délai répond « déjà en base » au lieu d'écrire deux fois).
      const r = await envoyer({ op: c.op, args: c.args, session, uid: `${c.uid}-t`.slice(-64) });
      abandonner(M, c.uid);
      imprimerChangements(r.changements || [], session);
      direCree(c.op, r);
      console.log(`appliqué ${c.uid}`);
      return 0;
    }
    if (verbe === "voir") { if (!sous) throw new ErreurClient(2, "voir CH-xx"); voir(await lireOuCopie(), sous); return fin(); }
    if (verbe === "taches") { taches(await lireOuCopie(), sous); return fin(); }
    if (verbe === "journal") {
      if (!sous) throw new ErreurClient(2, "journal \"texte\" attendu");
      await ecrire("ajouterJournal", { texte: sous, chantiers: opts.chantier || "", commits: opts.commits || "—", docs: opts.docs || "—" });
      return 0;
    }
    if (verbe === "chantier" || verbe === "tache") {
      const permisCh = ["titre", "etat", "prochaine_action", "decisions", "doc", "priorite", "note", "id"];
      const permisT = ["titre", "constat", "attendu", "domaine", "priorite", "statut", "decision", "chantier", "lot", "note", "id"];
      if (verbe === "chantier" && sous === "ajouter") { await ecrire("creerChantier", champs(opts, permisCh)); return 0; }
      if (verbe === "chantier" && sous === "maj") { const { id, ...c } = champs(opts, permisCh); await ecrire("modifierChantier", { id: cible, champs: c }); return 0; }
      if (verbe === "chantier" && sous === "clore") { await ecrire("cloreChantier", { id: cible, preuve: opts.preuve || "", reste: opts.reste || "", abandon: Boolean(opts.abandon) }); return 0; }
      if (verbe === "tache" && sous === "ajouter") { await ecrire("creerTache", { ...champs(opts, permisT), chantier: cible }); return 0; }
      if (verbe === "tache" && sous === "maj") { const { id, ...c } = champs(opts, permisT); await ecrire("modifierTache", { id: cible, champs: c }); return 0; }
      throw new ErreurClient(2, `${verbe} ${sous || ""} : ajouter, maj${verbe === "chantier" ? " ou clore" : ""} attendu`);
    }
    if (verbe) throw new ErreurClient(2, `commande inconnue : ${verbe}`);

    if (opts.exporter) {
      const e = await parler(`/api/p/${P}/export`);
      const dest = opts.remplacer ? null : join(ROOT, "docs", `export-${jour()}`);
      const cibles = (dest ? [join(dest, "CHANTIERS.md"), join(dest, "backlog.md")] : [at(ROOT, cfg, "chantiers"), at(ROOT, cfg, "backlog")]).map((p) => dans(ROOT, p));
      if (typeof e.chantiers !== "string" || typeof e.backlog !== "string") throw new ErreurClient(1, "export illisible");
      const json = dans(ROOT, dest ? join(dest, "chantiers.json") : join(at(ROOT, cfg, "tracker"), "chantiers.json"));
      for (const [p, texte] of [[cibles[0], e.chantiers], [cibles[1], e.backlog], [json, JSON.stringify(e.json, null, 4) + "\n"]]) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, texte, "utf8");
        console.log(`écrit ${posix(relative(ROOT, p))}`);
      }
      return 0;
    }

    if (multi.statut.length || multi.suivi.length || multi.lot.length || multi.chantier.length) {
      if (!session) throw new ErreurClient(2, "--session est requis avec --statut/--suivi/--lot/--chantier (qui a fait quoi)");
      await ecrire("session", { statuts: pairs(multi.statut, "--statut"), suivis: pairs(multi.suivi, "--suivi"), lots: pairs(multi.lot, "--lot"), rattachements: pairs(multi.chantier, "--chantier") });
    } else if (!opts.check && !opts.strict) {
      // Passage ordinaire : les specs du dépôt partent au BFF (lots, texte affiché dans la fiche).
      const d0 = await lireOuCopie();
      const specs = specsDuDepot(ROOT, cfg, d0.chantiers);
      if (specs.length && etat.copie) console.log("specs non envoyées : serveur injoignable");
      else if (specs.length) await envoyer({ op: "specs", args: { specs }, session: session || "synchro-specs" });
    }
    const d = await lireOuCopie();
    // Le réglage des .md n'est appliqué que d'après le BFF lui-même, jamais d'après une copie.
    if (!opts.check && !opts.strict && !etat.copie) appliquerReglageMd(ROOT, cfg, d.reglages || {});
    console.log(`${d.chantiers.length} chantiers, ${d.items.length} tâches (${etat.copie ? "copie" : "base"}, version ${d.meta.version})`);
    const incs = incoherences(d, { specs: cfg.specs, enCoursSpecSeulement: !!(cfg.controle && cfg.controle.enCoursSpecSeulement) });
    for (const inc of incs) console.log(`INCOHÉRENCE ${inc}`);
    return opts.strict && incs.length ? 1 : fin();
  } catch (e) {
    if (e instanceof EnAttente) { console.log(e.message); return e.code; }
    console.error(`ERREUR : ${e.message}`);
    return e instanceof ErreurClient ? e.code : 1;
  }
}

/** Relevé de code (code-stats.mjs) envoyé au BFF en mode base. */
export async function envoyerCode(ROOT, cfg, stats) {
  const jeton = jetonDe(cfg);
  if (!jeton) throw new Error(`aucun jeton pour ${cleJeton(cfg.bff, cfg.projetBase)}`);
  await appel(cfg.bff, jeton, `/api/p/${cfg.projetBase}/operation`, { op: "code", args: { stats }, session: "code-stats" });
}
