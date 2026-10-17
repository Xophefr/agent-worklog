// Construit chantiers.json, les données du tableau de suivi des chantiers (docs/tracker/).
// Les chemins viennent de tracker.config.json (voir config.mjs).
//
// Deux sources, écrites par les sessions (humaines ou agents) :
//   - CHANTIERS.md : état, prochaine action, décisions, doc et date de chaque CH-xx ;
//   - backlog.md : les tâches (API-01, UI-03…), rangées sous une section
//     « ## CH-xx · titre » qui donne leur chantier par défaut.
//
// Le JSON garde en plus ce que le propriétaire pilote depuis le tableau (priorité, rang,
// note, statut des tâches, rattachement). Relancer le script ne l'écrase jamais : il ne
// réécrit que les champs venus des deux sources.
//
//   npm run chantiers                     # fusionne et écrit
//   npm run chantiers -- --check          # dit ce qui changerait, n'écrit rien
//   npm run chantiers -- --strict         # code 1 s'il reste une INCOHÉRENCE
//
// Une SESSION écrit le statut et le suivi des tâches qu'elle touche :
//
//   npm run chantiers -- --session lot-2-api \
//     --statut API-01=en_cours --suivi "API-01=route écrite, reste les tests"
//
// `--suivi` va dans le champ `suivi` (date + session), jamais dans `note`, qui est au
// propriétaire. `--chantier ID=CH-xx` rattache une tâche à un autre chantier : une tâche
// déjà dans le JSON garde son rattachement, la section du backlog ne vaut que pour une
// tâche NOUVELLE ou dont le rattachement est vide sans que le tableau l'ait vidé exprès
// (`detache`, posé par l'enregistrement du tableau).
//
// Les LOTS d'un chantier sont la liste numérotée de la section « ## Découpage » de sa spec
// (<specs>/CH-xx_*.md, citée dans la colonne « doc » de CHANTIERS.md). Une tâche y est
// rattachée (`lot_spec`) quand la ligne du lot la nomme ; `--lot ID=N` ou le tableau priment.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { at, CONFIG_FILE, findRoot, loadConfig } from "./config.mjs";

const ID_RE = "[A-Z]{2,4}-\\d{2}";
export const STATUTS = ["a_faire", "en_cours", "a_verifier", "fait", "abandonne"]; // = patch.mjs, save.php et app.js
const BOUGE = new Set(["en_cours", "a_verifier", "fait"]);

const clean = (t) => String(t).replace(/\s+/g, " ").trim();
const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const reEsc = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Minuscules sans accents : « Terminé », « terminé » et « termine » se lisent pareil. */
export const fold = (t) => String(t).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const posix = (p) => p.replaceAll("\\", "/");

/** Le mot qui marque une tâche « décision attendue » (réglage `ui.marque`), accents et casse indifférents. */
export function marqueRe(marque = "DÉCISION") {
  const VAR = { a: "aàâä", c: "cç", e: "eéèêë", i: "iîï", o: "oôö", u: "uùûü" };
  return new RegExp([...fold(marque)].map((ch) => (VAR[ch] ? `[${VAR[ch]}]` : reEsc(ch))).join(""), "i");
}

// ---------- backlog ----------
export function parseBacklog(text, marque = marqueRe()) {
  const items = [];
  const seen = new Set();
  let section = "";
  let chantier = null;
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      section = clean(h[1]);
      const ch = section.match(/^(CH-\d+)\b/);
      chantier = ch ? ch[1] : null;
      continue;
    }
    if (!new RegExp(`^\\|\\s*${ID_RE}\\s*\\|\\s*P\\d\\s*\\|`).test(line)) continue;
    const c = cells(line);
    if (seen.has(c[0])) continue;
    seen.add(c[0]);
    let titre = c[2] || "";
    let constat = "";
    const b = titre.match(/^\*\*(.+?)\*\*\s*(.*)$/); // « **Titre.** détail »
    if (b) { titre = b[1].replace(/\.$/, ""); constat = b[2]; }
    const attendu = c[3] || "";
    items.push({
      id: c[0],
      titre: clean(titre).slice(0, 160),
      priorite: c[1],
      constat: clean(constat),
      attendu: clean(attendu),
      decision: marque.test(line),
      domaine: c[0].split("-")[0],
      section,
      ligne: n + 1,
      chantier_backlog: chantier,
    });
  }
  return items;
}

// ---------- CHANTIERS.md ----------
export function etatColonne(etat) {
  const e = fold(etat);
  if (e.includes("abandonn")) return "abandonne";
  if (e.includes("bloque")) return "bloque";
  if (e.includes("pas commence")) return "pas_commence";
  if (/^(termine|livre|en service)/.test(e) || e.includes("termine")) return "termine";
  return "en_cours";
}

export function parseChantiers(text) {
  const out = [];
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      section = fold(line.slice(3).trim());
      if (section === "journal") break;
      continue;
    }
    if (!/^\|\s*CH-\d+/.test(line)) continue;
    const c = cells(line);
    const id = c[0].match(/CH-\d+[a-z]?/)[0];
    if (section.startsWith("chantiers clos") && c.length >= 5) {
      // Un chantier abandonné descend aussi ici, avec **ABANDONNÉ** dans son titre.
      const col = /abandonn/i.test(fold(c[1])) ? "abandonne" : "clos";
      out.push({ id, titre: c[1], etat: col, clos_le: c[2], preuve: c[3], reste: c[4], maj: c[2], colonne: col });
    } else if (c.length >= 7) {
      out.push({ id, titre: c[1], etat: c[2], prochaine_action: c[3], decisions: c[4], doc: c[5], maj: c[6], colonne: etatColonne(c[2]) });
    }
  }
  return out;
}

// ---------- lots ----------
/** La spec citée dans la colonne « doc » d'un chantier : <specs>/CH-xx_titre.md. */
export const specRe = (specs = "docs/chantiers") => new RegExp(`${reEsc(String(specs).replace(/\/+$/, ""))}/(CH-\\d+[_.][^\`\\s)]*\\.md)`);

function expand(prefix, token) {
  const t = token.trim().replace(/^\+/, "").trim();
  const m = t.match(/^(\d{1,2})\s*[-–]\s*(\d{1,2})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    return a <= b ? Array.from({ length: b - a + 1 }, (_, k) => `${prefix}-${String(a + k).padStart(2, "0")}`) : [];
  }
  return /^\d+$/.test(t) ? [`${prefix}-${String(Number(t)).padStart(2, "0")}`] : [];
}

/** Les ids qu'une ligne de lot nomme : « API-02, 05 », « API-01 à 04 », « (03-05) ». */
export function lotIds(text, defaultPrefix) {
  const found = [];
  for (const m of text.matchAll(new RegExp(ID_RE, "g"))) found.push(m[0]);
  for (const m of text.matchAll(new RegExp(`(${ID_RE})((?:\\s*,\\s*\\d{2}(?:\\s*-\\s*\\d{2})?)+)`, "g"))) {
    const prefix = m[1].split("-")[0];
    for (const tok of m[2].split(",")) found.push(...expand(prefix, tok));
  }
  for (const m of text.matchAll(new RegExp(`(${ID_RE})\\s*(?:à|-)\\s*(\\d{2})\\b((?:\\s*,\\s*\\d{2}\\b)*)`, "g"))) {
    const [prefix, start] = m[1].split("-");
    found.push(...expand(prefix, `${start}-${m[2]}`));
    for (const tok of (m[3] || "").split(",")) found.push(...expand(prefix, tok));
  }
  if (defaultPrefix) {
    for (const m of text.matchAll(/\(([\s\d,+\-–]+)\)/g)) for (const tok of m[1].split(",")) found.push(...expand(defaultPrefix, tok));
  }
  return [...new Set(found)];
}

export function parseLots(specText) {
  const lots = [];
  let inside = false;
  for (const line of specText.split(/\r?\n/)) {
    if (line.startsWith("## ")) { inside = fold(line).startsWith("## decoupage"); continue; }
    const m = inside ? line.trim().match(/^(\d+)\.\s+(.+)$/) : null;
    if (!m) continue;
    const body = m[2];
    const b = body.match(/^\*\*(.+?)\*\*/);
    const titre = b ? clean(b[1]) : clean(body.replace(/\([^)]*\)/g, "").replace(/[*`]/g, "")).replace(/[ .,:;]+$/, "").slice(0, 70);
    lots.push({ id: m[1], titre, texte: clean(body) });
  }
  return lots;
}

const specReader = (dir) => (name) => {
  const p = join(dir, name);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
};

// ---------- fusion ----------
const MD_OWNED_CH = ["titre", "etat", "prochaine_action", "decisions", "doc", "maj", "colonne", "clos_le", "preuve", "reste", "lots"];
const MD_OWNED_IT = ["titre", "constat", "attendu", "domaine", "section", "ligne", "decision", "lot_spec"];

/** Le rattachement d'une tâche : celui du JSON ; à défaut, sa section du backlog (sauf détachement voulu). */
function chantierEffectif(prev, it) {
  if (prev.chantier) return prev.chantier;
  if (prev.detache) return null;
  return it.chantier_backlog;
}

/**
 * Fusionne l'ancien JSON et les deux sources. `read(nom)` rend le texte d'une spec (ou null) ;
 * `opts` porte les chemins du réglage et ce que le tableau affiche (`projet`, `ui`).
 */
export function merge(old, chantiers, items, read = () => null, opts = {}) {
  const SPEC_RE = specRe(opts.specs);
  const oldCh = new Map((old.chantiers || []).map((c) => [c.id, c]));
  const oldIt = new Map((old.items || []).map((i) => [i.id, i]));
  const eff = new Map(items.map((it) => [it.id, chantierEffectif(oldIt.get(it.id) || {}, it)]));

  for (const c of chantiers) {
    const m = String(c.doc || "").match(SPEC_RE);
    const text = m ? read(m[1]) : null;
    c.lots = text ? parseLots(text) : [];
    const own = items.filter((i) => eff.get(i.id) === c.id);
    const doms = own.map((i) => i.domaine);
    const prefix = doms.sort((a, b) => doms.filter((d) => d === b).length - doms.filter((d) => d === a).length)[0] || "";
    const mine = new Set(own.map((i) => i.id));
    for (const lot of c.lots) lot.taches = lotIds(lot.texte, prefix).filter((t) => mine.has(t));
  }
  for (const it of items) {
    const ch = chantiers.find((c) => c.id === eff.get(it.id));
    it.lot_spec = ch ? (ch.lots.find((l) => l.taches.includes(it.id)) || {}).id || null : null;
  }

  const best = {};
  for (const it of items) {
    const ch = eff.get(it.id);
    if (ch && (!best[ch] || it.priorite < best[ch])) best[ch] = it.priorite;
  }

  const newCh = chantiers.map((c, k) => {
    const prev = oldCh.get(c.id) || {};
    oldCh.delete(c.id);
    const row = { ...prev };
    for (const f of MD_OWNED_CH) if (f in c) row[f] = c[f];
    row.id = c.id;
    delete row.orphelin;
    row.priorite ??= best[c.id] || "P2";
    row.rang ??= k + 1;
    row.note ??= "";
    return row;
  });
  for (const gone of oldCh.values()) newCh.push({ ...gone, orphelin: true }); // disparu de CHANTIERS.md : gardé, marqué

  const newIt = items.map((it) => {
    const prev = oldIt.get(it.id) || {};
    oldIt.delete(it.id);
    const row = { ...prev };
    for (const f of MD_OWNED_IT) row[f] = it[f];
    row.id = it.id;
    delete row.orphelin;
    row.priorite ??= it.priorite;
    row.chantier = eff.get(it.id) || null;
    row.statut ??= "a_faire";
    row.note ??= "";
    return row;
  });
  for (const gone of oldIt.values()) newIt.push({ ...gone, orphelin: true });

  const meta = { ...(old.meta || {}) };
  meta.version = Number(meta.version || 0) + 1;
  meta.synchro_md = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  meta.sources = { chantiers: opts.chantiers || "docs/CHANTIERS.md", backlog: opts.backlog || "docs/chantiers/backlog.md" };
  if (opts.projet) meta.projet = opts.projet;
  if (opts.ui) meta.ui = opts.ui;
  return { meta, chantiers: newCh, items: newIt };
}

// ---------- session ----------
function pairs(values, flag) {
  return values.map((v) => {
    const k = v.indexOf("=");
    if (k < 0) throw new Error(`${flag} attend ID=valeur, reçu « ${v} »`);
    return [v.slice(0, k).trim(), v.slice(k + 1).trim()];
  });
}

/** Écrit statut, suivi, lot et rattachement des tâches nommées. Tout ou rien (Error). */
export function applySession(data, { statuts = [], suivis = [], lots = [], rattachements = [] }, session, jour) {
  const byId = new Map(data.items.map((i) => [i.id, i]));
  const need = (tid) => { if (!byId.has(tid)) throw new Error(`tâche inconnue : ${tid}`); };
  for (const [tid, st] of statuts) { need(tid); if (!STATUTS.includes(st)) throw new Error(`statut « ${st} » hors vocabulaire (${STATUTS.join(", ")})`); }
  for (const [tid] of suivis) need(tid);
  const connus = new Set(data.chantiers.filter((c) => !c.orphelin).map((c) => c.id));
  for (const [tid, ch] of rattachements) { need(tid); if (!connus.has(ch)) throw new Error(`chantier inconnu : ${ch} (il doit avoir sa ligne dans CHANTIERS.md)`); }
  const faits = [];
  for (const [tid, ch] of rattachements) {
    const it = byId.get(tid);
    if (it.chantier !== ch) delete it.lot; // un numéro de lot n'a de sens que dans SON chantier
    faits.push(`${tid} : chantier ${it.chantier || "aucun"} -> ${ch}`);
    it.chantier = ch;
    delete it.detache;
  }
  const lotsOf = new Map(data.chantiers.map((c) => [c.id, new Set((c.lots || []).map((l) => l.id))]));
  for (const [tid, lot] of lots) {
    need(tid);
    const ch = byId.get(tid).chantier;
    if (!(lotsOf.get(ch) || new Set()).has(lot)) throw new Error(`${tid} : le chantier ${ch} n'a pas de lot « ${lot} »`);
  }
  for (const [tid, lot] of lots) {
    const it = byId.get(tid);
    faits.push(`${tid} : lot ${it.lot || it.lot_spec || "aucun"} -> ${lot}`);
    it.lot = lot;
  }
  const texte = new Map(suivis);
  for (const [tid, st] of statuts) {
    const it = byId.get(tid);
    const detail = texte.get(tid) || "";
    texte.delete(tid);
    faits.push(`${tid} : ${it.statut} -> ${st}`);
    it.statut = st;
    it.suivi = `${jour} · ${session} · ${st}` + (detail ? ` : ${detail}` : "");
  }
  for (const [tid, detail] of texte) {
    byId.get(tid).suivi = `${jour} · ${session} : ${detail}`;
    faits.push(`${tid} : suivi mis à jour`);
  }
  return faits;
}

/** L'état d'un chantier et le statut de ses tâches doivent dire la même chose. */
export function incoherences(data) {
  const out = [];
  for (const c of data.chantiers) {
    if (c.orphelin) continue;
    const its = data.items.filter((i) => i.chantier === c.id && !i.orphelin);
    const col = c.colonne;
    if (!its.length) {
      if (!["clos", "abandonne"].includes(col)) out.push(`${c.id} est ${col} mais n'a AUCUNE tâche : lui écrire des tâches dans le backlog, ou le clore`);
      continue;
    }
    if (col === "en_cours" && !its.some((i) => BOUGE.has(i.statut))) {
      out.push(`${c.id} est « en cours » mais ses ${its.length} tâches sont toutes à faire : passer celles qu'il traite en en_cours`);
    }
    const avance = its.filter((i) => ["en_cours", "fait"].includes(i.statut)).map((i) => i.id);
    if (col === "pas_commence" && avance.length) out.push(`${c.id} est « pas commencé » mais ${avance.join(", ")} a/ont avancé : mettre à jour CHANTIERS.md`);
    if (["termine", "clos", "abandonne"].includes(col)) {
      const ouvertes = its.filter((i) => ["a_faire", "en_cours"].includes(i.statut)).map((i) => i.id);
      if (ouvertes.length) out.push(`${c.id} est ${col} mais ${ouvertes.join(", ")} restent ouvertes : fait, abandonné, ou rattacher ailleurs`);
    }
  }
  return out;
}

// ---------- ligne de commande ----------
function parseArgs(argv) {
  const a = { check: false, strict: false, session: "", statut: [], suivi: [], lot: [], chantier: [] };
  for (let k = 0; k < argv.length; k++) {
    // « --statut ID=val » ou « --statut=ID=val » : la valeur contient elle-même un « = ».
    const m = argv[k].match(/^(--[a-z]+)(?:=(.*))?$/s);
    const name = m ? m[1] : argv[k];
    const value = () => (m && m[2] !== undefined ? m[2] : argv[++k] ?? "");
    if (name === "--check") a.check = true;
    else if (name === "--strict") a.strict = true;
    else if (name === "--session") a.session = value();
    else if (name === "--root") value(); // lu par findRoot()
    else if (["--statut", "--suivi", "--lot", "--chantier"].includes(name)) a[name.slice(2)].push(value());
    else throw new Error(`option inconnue : ${argv[k]}`);
  }
  return a;
}

function main() {
  const ROOT = findRoot();
  let args, cfg;
  try { args = parseArgs(process.argv.slice(2)); cfg = loadConfig(ROOT); } catch (e) { console.error(`ERREUR : ${e.message}`); return 2; }
  const CHANTIERS_MD = at(ROOT, cfg, "chantiers");
  const BACKLOG_MD = at(ROOT, cfg, "backlog");
  const TRACKER = at(ROOT, cfg, "tracker");
  const OUT_JSON = join(TRACKER, "chantiers.json");
  for (const p of [CHANTIERS_MD, BACKLOG_MD]) {
    if (!existsSync(p)) { console.error(`ERREUR : ${posix(relative(ROOT, p))} introuvable (chemins dans ${CONFIG_FILE})`); return 2; }
  }
  const old = existsSync(OUT_JSON) ? JSON.parse(readFileSync(OUT_JSON, "utf8")) : {};
  const chantiers = parseChantiers(readFileSync(CHANTIERS_MD, "utf8"));
  const items = parseBacklog(readFileSync(BACKLOG_MD, "utf8"), marqueRe(cfg.ui.marque));
  // Le tableau lit son réglage dans le JSON : aucun fichier de plus à servir, et WAMP, le
  // serveur Node ou tout autre serveur statique affichent la même chose.
  const racine = posix(relative(TRACKER, ROOT));
  const data = merge(old, chantiers, items, specReader(at(ROOT, cfg, "specs")), {
    specs: cfg.specs, chantiers: cfg.chantiers, backlog: cfg.backlog, projet: cfg.projet,
    ui: { ...cfg.ui, racine: racine ? racine + "/" : "", backlog: posix(relative(TRACKER, BACKLOG_MD)) },
  });

  if (args.statut.length || args.suivi.length || args.lot.length || args.chantier.length) {
    if (!args.session) { console.error("ERREUR : --session est requis avec --statut/--suivi/--lot/--chantier (qui a fait quoi)"); return 2; }
    const d = new Date();
    const jour = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    try {
      const faits = applySession(data, {
        statuts: pairs(args.statut, "--statut"), suivis: pairs(args.suivi, "--suivi"),
        lots: pairs(args.lot, "--lot"), rattachements: pairs(args.chantier, "--chantier"),
      }, args.session, jour);
      for (const f of faits) console.log(`  ${f}`);
    } catch (e) { console.error(`ERREUR : ${e.message} -- rien n'est écrit`); return 2; }
  }

  const orphans = data.items.filter((i) => !i.chantier).map((i) => i.id);
  const known = new Set(data.chantiers.map((c) => c.id));
  const unknown = [...new Set(data.items.map((i) => i.chantier).filter((c) => c && !known.has(c)))];
  console.log(`${data.chantiers.length} chantiers, ${data.items.length} tâches ; sans chantier : ${orphans.join(", ") || "aucune"}`);
  if (unknown.length) console.log(`ATTENTION rattachement vers un chantier absent de CHANTIERS.md : ${unknown.join(", ")}`);
  const incs = incoherences(data);
  for (const inc of incs) console.log(`INCOHÉRENCE ${inc}`);
  if (!args.check) {
    mkdirSync(dirname(OUT_JSON), { recursive: true });
    writeFileSync(OUT_JSON, JSON.stringify(data, null, 4) + "\n", "utf8"); // même format que l'enregistrement du tableau : diffs lisibles
    console.log(`écrit ${posix(relative(ROOT, OUT_JSON))} (version ${data.meta.version})`);
  }
  return args.strict && incs.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) process.exitCode = main();
