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
//
// Jetons, jamais dans le dépôt : ~/.agent-worklog/jetons.json { "<origine du BFF>|<projet>": "<jeton>" } (ou
// WORKLOG_TOKEN) ; l'import se fait avec le jeton d'interface de ~/.agent-worklog/bff-lies.json.
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { at, CONFIG_FILE } from "./config.mjs";
import { construire, incoherences, pairs, parseJournal, specRe } from "./chantiers-tracker.mjs";

const maison = () => process.env.AGENT_WORKLOG_HOME || join(homedir(), ".agent-worklog");
const lireJson = (f, d) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };
const posix = (p) => p.replaceAll("\\", "/");
const jour = () => new Date().toLocaleDateString("en-CA");
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

async function appel(url, jeton, chemin, corps) {
  let r;
  try {
    r = await fetch(url.replace(/\/+$/, "") + chemin, {
      method: corps === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${jeton}`, "Content-Type": "application/json" },
      body: corps === undefined ? undefined : JSON.stringify(corps),
    });
  } catch { throw new ErreurClient(1, `BFF injoignable (${url}) : rien n'est écrit. Le BFF tourne-t-il (npm run bff), le tunnel est-il ouvert ?`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new ErreurClient(1, `${j.error || `HTTP ${r.status}`} -- rien n'est écrit`);
  return j;
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
  const ji = lies[url];
  if (!ji) throw new ErreurClient(2, `pas de jeton d'interface pour ${url} : lier d'abord le BFF (node scripts/worklog/accueil.mjs lier-bff ${url} <jeton>, depuis agent-worklog)`);
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
    const lire = () => appel(cfg.bff, jeton, `/p/${P}/chantiers.json`);
    const session = typeof opts.session === "string" ? opts.session.trim() : "";
    const ecrire = async (op, args) => {
      if (!session) throw new ErreurClient(2, "--session est requis pour écrire (qui a fait quoi)");
      const r = await appel(cfg.bff, jeton, `/api/p/${P}/operation`, { op, args, session });
      imprimerChangements(r.changements || [], session);
      return r;
    };
    const [verbe, sous, cible] = mots;

    if (verbe === "voir") { if (!sous) throw new ErreurClient(2, "voir CH-xx"); voir(await lire(), sous); return 0; }
    if (verbe === "taches") { taches(await lire(), sous); return 0; }
    if (verbe === "journal") {
      if (!sous) throw new ErreurClient(2, "journal \"texte\" attendu");
      await ecrire("ajouterJournal", { texte: sous, chantiers: opts.chantier || "", commits: opts.commits || "—", docs: opts.docs || "—" });
      return 0;
    }
    if (verbe === "chantier" || verbe === "tache") {
      const permisCh = ["titre", "etat", "prochaine_action", "decisions", "doc", "priorite", "note", "id"];
      const permisT = ["titre", "constat", "attendu", "domaine", "priorite", "statut", "decision", "chantier", "lot", "note", "id"];
      if (verbe === "chantier" && sous === "ajouter") { const r = await ecrire("creerChantier", champs(opts, permisCh)); console.log(`créé ${r.resultat}`); return 0; }
      if (verbe === "chantier" && sous === "maj") { const { id, ...c } = champs(opts, permisCh); await ecrire("modifierChantier", { id: cible, champs: c }); return 0; }
      if (verbe === "chantier" && sous === "clore") { await ecrire("cloreChantier", { id: cible, preuve: opts.preuve || "", reste: opts.reste || "", abandon: Boolean(opts.abandon) }); return 0; }
      if (verbe === "tache" && sous === "ajouter") { const r = await ecrire("creerTache", { ...champs(opts, permisT), chantier: cible }); console.log(`créée ${r.resultat}`); return 0; }
      if (verbe === "tache" && sous === "maj") { const { id, ...c } = champs(opts, permisT); await ecrire("modifierTache", { id: cible, champs: c }); return 0; }
      throw new ErreurClient(2, `${verbe} ${sous || ""} : ajouter, maj${verbe === "chantier" ? " ou clore" : ""} attendu`);
    }
    if (verbe) throw new ErreurClient(2, `commande inconnue : ${verbe}`);

    if (opts.exporter) {
      const e = await appel(cfg.bff, jeton, `/api/p/${P}/export`);
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
      const d0 = await lire();
      const specs = specsDuDepot(ROOT, cfg, d0.chantiers);
      if (specs.length) await appel(cfg.bff, jeton, `/api/p/${P}/operation`, { op: "specs", args: { specs }, session: session || "synchro-specs" });
    }
    const d = await lire();
    if (!opts.check && !opts.strict) appliquerReglageMd(ROOT, cfg, d.reglages || {});
    console.log(`${d.chantiers.length} chantiers, ${d.items.length} tâches (base, version ${d.meta.version})`);
    const incs = incoherences(d, { specs: cfg.specs, enCoursSpecSeulement: !!(cfg.controle && cfg.controle.enCoursSpecSeulement) });
    for (const inc of incs) console.log(`INCOHÉRENCE ${inc}`);
    return opts.strict && incs.length ? 1 : 0;
  } catch (e) {
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
