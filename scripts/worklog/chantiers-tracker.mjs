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
// déjà dans le JSON garde son rattachement, la section du backlog (à défaut, le réglage
// `rattachements`) ne vaut que pour une tâche NOUVELLE ou dont le rattachement est vide sans
// que le tableau l'ait vidé exprès (`detache`, posé par l'enregistrement du tableau).
//
// Les LOTS d'un chantier sont la liste numérotée de la section « ## Découpage » de sa spec
// (<specs>/CH-xx_*.md, citée dans la colonne « doc » de CHANTIERS.md). Une tâche y est
// rattachée (`lot_spec`) quand la ligne du lot la nomme ; `--lot ID=N` ou le tableau priment.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { at, CONFIG_FILE, estLance, findRoot, loadConfig } from "./config.mjs";

// Préfixe de 2 à 4 caractères, majuscules et chiffres, commençant par une lettre : API-01, I18N-04.
const ID_RE = "[A-Z][A-Z0-9]{1,3}-\\d{2}";
export const STATUTS = ["a_faire", "en_cours", "a_verifier", "fait", "abandonne"]; // = patch.mjs, save.php et app.js
const BOUGE = new Set(["en_cours", "a_verifier", "fait"]);

const clean = (t) => String(t).replace(/\s+/g, " ").trim();
// Cellules d'une ligne de tableau ; « \| » est une barre dans le texte, pas un séparateur.
const cells = (line) => line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replaceAll("\\|", "|"));
const reEsc = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Minuscules sans accents : « Terminé », « terminé » et « termine » se lisent pareil. */
export const fold = (t) => String(t).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const posix = (p) => p.replaceAll("\\", "/");

/**
 * Le mot qui marque une tâche « décision attendue » (réglage `ui.marque`), accents indifférents.
 * Casse indifférente aussi, sauf `casse` (réglage `ui.marqueCasse`) : alors seul le mot écrit
 * comme le réglage compte, et « DÉCISION » ne se confond plus avec « la décision du 4 octobre ».
 */
export function marqueRe(marque = "DÉCISION", casse = false) {
  const VAR = { a: "aàâä", c: "cç", e: "eéèêë", i: "iîï", o: "oôö", u: "uùûü" };
  const base = String(marque).normalize("NFD").replace(/[̀-ͯ]/g, "");
  return new RegExp([...base].map((ch) => {
    const v = VAR[ch.toLowerCase()];
    if (!v) return reEsc(ch);
    return `[${casse && ch !== ch.toLowerCase() ? v.toUpperCase() : v}]`;
  }).join(""), casse ? "" : "i");
}

// ---------- backlog ----------
// Une tâche s'écrit en ligne de tableau (le format documenté), ou bien en titre
// « ### API-01 : titre `P1` », ou en paragraphe « **API-01** `P1` : texte ». La lecture
// s'arrête au premier « ## Annexe » : une annexe cite des tâches, elle n'en déclare pas.
const ROW_RE = new RegExp(`^\\|\\s*${ID_RE}\\s*\\|\\s*P\\d\\s*\\|`);
const HEAD_RE = new RegExp(`^#{3,4} (${ID_RE}) : (.+?) \`(P\\d)\``);
const PARA_RE = new RegExp(`^\\*\\*(${ID_RE})\\*\\* \`(P\\d)\` : (.+)$`);

export function parseBacklog(text, marque = marqueRe()) {
  const items = [];
  const seen = new Set();
  let section = "";
  let chantier = null;
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (/^##\s+annexe\b/i.test(fold(line))) break;
    const h = line.match(/^(#{2,3})\s+(.+)$/);
    if (h && !HEAD_RE.test(line)) {
      // Le rattachement vient d'une section « ## CH-xx » ; une sous-section ne fait que la préciser.
      // « ### 4.2 Recherche `RCH` » se lit « Recherche » : ni numéro, ni code du domaine.
      section = clean(h[2]).replace(/^[\d.]+\s+/, "").replace(/\s+`[A-Z0-9]+`$/, "");
      if (h[1] === "##") { const ch = section.match(/^(CH-\d+)\b/); chantier = ch ? ch[1] : null; }
      continue;
    }
    let rec = null;
    const t = line.match(HEAD_RE);
    const p = !t && line.match(PARA_RE);
    if (t) rec = { id: t[1], titre: t[2], priorite: t[3], constat: "", attendu: "" };
    else if (p) rec = { id: p[1], titre: p[3], priorite: p[2], constat: p[3], attendu: "" };
    else if (ROW_RE.test(line)) {
      const c = cells(line);
      // Le titre est coupé à 160 caractères : le constat garde la cellule entière.
      rec = { id: c[0], titre: c[2] || "", priorite: c[1], constat: c[2] || "", attendu: c[3] || "" };
      const b = rec.titre.match(/^\*\*(.+?)\*\*\s*(.*)$/); // « **Titre.** détail »
      if (b) { rec.titre = b[1].replace(/\.$/, ""); rec.constat = b[2]; }
    }
    if (!rec || seen.has(rec.id)) continue;
    seen.add(rec.id);
    items.push({
      id: rec.id,
      titre: clean(rec.titre).slice(0, 160),
      priorite: rec.priorite,
      constat: clean(rec.constat),
      attendu: clean(rec.attendu),
      decision: marque.test(line),
      domaine: rec.id.split("-")[0],
      section,
      ligne: n + 1,
      chantier_backlog: chantier,
    });
  }
  return items;
}

/** Rattachements par défaut du réglage : { "CH-04": "API-01 API-02" ou [...] } -> Map id -> chantier. */
export function rattachementsParDefaut(cfg = {}) {
  const out = new Map();
  for (const [ch, ids] of Object.entries(cfg || {})) {
    for (const id of Array.isArray(ids) ? ids : String(ids).split(/[\s,]+/)) if (id) out.set(id, ch);
  }
  return out;
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

// ---------- journal ----------
/**
 * Le journal en bas de CHANTIERS.md : le paragraphe de consigne, puis un tableau
 * | date | session | chantier | ce qui a bougé | commits | docs |. Une ligne qui n'est pas une
 * ligne du tableau est gardée telle quelle ({ brut }) : rien n'est jeté.
 */
export function parseJournal(text) {
  const out = { consigne: "", entrees: [] };
  const lines = text.split(/\r?\n/);
  const k = lines.findIndex((l) => l.startsWith("## ") && fold(l.slice(3).trim()) === "journal");
  if (k < 0) return out;
  const consigne = [];
  let table = false;
  for (const line of lines.slice(k + 1)) {
    if (!line.trim()) continue;
    if (line.startsWith("## ")) break;
    if (/^\|/.test(line)) {
      if (!table) { table = true; continue; } // en-tête
      if (/^\|[\s|:-]+\|?\s*$/.test(line)) continue; // séparateur
      const c = cells(line);
      if (c.length >= 6) out.entrees.push({ date: c[0], session: c[1], chantiers: c[2], texte: c[3], commits: c[4], docs: c[5] });
      else out.entrees.push({ brut: line.trim() });
    } else if (!table) consigne.push(line.trim());
    else out.entrees.push({ brut: line.trim() });
  }
  out.consigne = consigne.join("\n");
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
    // Sans ses parenthèses, « Liste (API-02), puis » ne doit pas laisser « Liste , puis ».
    const titre = b ? clean(b[1]) : clean(body.replace(/\([^)]*\)/g, "").replace(/[*`]/g, "")).replace(/\s+([,.])/g, "$1").replace(/[ .,:;]+$/, "").slice(0, 70);
    lots.push({ id: m[1], titre, texte: clean(body) });
  }
  return lots;
}

/**
 * Pose sur le chantier `c` les lots de sa spec (`text`, ou rien) et, pour chacun, les tâches
 * de `own` (ses tâches) que la ligne du lot nomme ; le préfixe par défaut est le domaine
 * le plus fréquent de ses tâches (« (03-05) » se lit API-03 à API-05).
 */
export function rattacherLots(c, text, own) {
  c.lots = text ? parseLots(text) : [];
  const doms = own.map((i) => i.domaine);
  const prefix = doms.sort((a, b) => doms.filter((d) => d === b).length - doms.filter((d) => d === a).length)[0] || "";
  const mine = new Set(own.map((i) => i.id));
  for (const lot of c.lots) lot.taches = lotIds(lot.texte, prefix).filter((t) => mine.has(t));
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
    rattacherLots(c, m ? read(m[1]) : null, items.filter((i) => eff.get(i.id) === c.id));
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
export function pairs(values, flag) {
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
// `opts.enCoursSpecSeulement` (réglage controle.enCoursSpecSeulement) : seul un chantier dont la
// doc est une spec du dossier `specs` avance par ses tâches ; un chantier plus ancien que le
// suivi peut être en cours sur son périmètre d'origine sans qu'aucune tâche ne bouge.
export function incoherences(data, opts = {}) {
  const out = [];
  const SPEC_RE = specRe(opts.specs);
  for (const c of data.chantiers) {
    if (c.orphelin) continue;
    const its = data.items.filter((i) => i.chantier === c.id && !i.orphelin);
    const col = c.colonne;
    if (!its.length) {
      if (!["clos", "abandonne"].includes(col)) out.push(`${c.id} est ${col} mais n'a AUCUNE tâche : lui écrire des tâches dans le backlog, ou le clore`);
      continue;
    }
    const suivi = !opts.enCoursSpecSeulement || SPEC_RE.test(String(c.doc || ""));
    if (col === "en_cours" && suivi && !its.some((i) => BOUGE.has(i.statut))) {
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

/**
 * Les données du mode fichiers, lues dans les Markdown du projet et fusionnées avec son
 * chantiers.json : { data, OUT_JSON, CHANTIERS_MD, BACKLOG_MD }. Lève une Error si un fichier manque.
 * Sert aussi à l'import vers le mode base (client.mjs).
 */
export function construire(ROOT, cfg) {
  const CHANTIERS_MD = at(ROOT, cfg, "chantiers");
  const BACKLOG_MD = at(ROOT, cfg, "backlog");
  const TRACKER = at(ROOT, cfg, "tracker");
  const OUT_JSON = join(TRACKER, "chantiers.json");
  for (const p of [CHANTIERS_MD, BACKLOG_MD]) {
    if (!existsSync(p)) throw new Error(`${posix(relative(ROOT, p))} introuvable (chemins dans ${CONFIG_FILE})`);
  }
  const old = existsSync(OUT_JSON) ? JSON.parse(readFileSync(OUT_JSON, "utf8")) : {};
  const chantiers = parseChantiers(readFileSync(CHANTIERS_MD, "utf8"));
  const items = parseBacklog(readFileSync(BACKLOG_MD, "utf8"), marqueRe(cfg.ui.marque, !!cfg.ui.marqueCasse));
  // Backlog qui n'est pas rangé par chantier : le réglage `rattachements` donne le chantier par défaut.
  const defauts = rattachementsParDefaut(cfg.rattachements);
  for (const it of items) it.chantier_backlog ||= defauts.get(it.id) || null;
  // Le tableau lit son réglage dans le JSON : aucun fichier de plus à servir, et WAMP, le
  // serveur Node ou tout autre serveur statique affichent la même chose.
  const racine = posix(relative(TRACKER, ROOT));
  const data = merge(old, chantiers, items, specReader(at(ROOT, cfg, "specs")), {
    specs: cfg.specs, chantiers: cfg.chantiers, backlog: cfg.backlog, projet: cfg.projet,
    ui: { ...cfg.ui, racine: racine ? racine + "/" : "", backlog: posix(relative(TRACKER, BACKLOG_MD)) },
  });
  return { data, OUT_JSON, CHANTIERS_MD, BACKLOG_MD };
}

function main() {
  const ROOT = findRoot();
  const argv = process.argv.slice(2);
  let cfg;
  try { cfg = loadConfig(ROOT); } catch (e) { console.error(`ERREUR : ${e.message}`); return 2; }
  // Mode base (ou import vers le mode base) : le client du BFF, chargé seulement dans ce cas.
  if (cfg.mode === "base" || argv.includes("--importer")) return import("./client.mjs").then((m) => m.mainBase(ROOT, cfg, argv));
  let args, built;
  try { args = parseArgs(argv); built = construire(ROOT, cfg); } catch (e) { console.error(`ERREUR : ${e.message}`); return 2; }
  const { data, OUT_JSON } = built;

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
  const incs = incoherences(data, { specs: cfg.specs, enCoursSpecSeulement: !!(cfg.controle && cfg.controle.enCoursSpecSeulement) });
  for (const inc of incs) console.log(`INCOHÉRENCE ${inc}`);
  if (!args.check) {
    mkdirSync(dirname(OUT_JSON), { recursive: true });
    writeFileSync(OUT_JSON, JSON.stringify(data, null, 4) + "\n", "utf8"); // même format que l'enregistrement du tableau : diffs lisibles
    console.log(`écrit ${posix(relative(ROOT, OUT_JSON))} (version ${data.meta.version})`);
  }
  return args.strict && incs.length ? 1 : 0;
}

if (estLance(import.meta.url)) {
  Promise.resolve(main()).then((c) => { process.exitCode = c; }, (e) => { console.error(`ERREUR : ${e.message}`); process.exitCode = 1; });
}
