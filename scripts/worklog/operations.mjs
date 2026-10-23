// Opérations du mode base sur les données d'un projet (forme de chantiers.json : { meta,
// chantiers, items, journal }). Fonctions pures : elles modifient `data` et lèvent une Error en
// français ; le dépôt de données (base/depot.mjs) les applique sous verrou, compare avant/après
// et écrit l'historique. Les mêmes règles qu'en mode fichiers : état -> colonne, ids, statuts.
import { etatColonne, rattacherLots, STATUTS } from "./chantiers-tracker.mjs";

const PRIOS = ["P0", "P1", "P2", "P3"];
const ID_TACHE = /^[A-Z][A-Z0-9]{1,3}-\d{2,}$/;
const ID_CHANTIER = /^CH-\d+[a-z]?$/;

const CHAMPS_CHANTIER = ["titre", "etat", "prochaine_action", "decisions", "doc", "priorite", "note", "maj"];
const CHAMPS_TACHE = ["titre", "constat", "attendu", "domaine", "priorite", "statut", "decision", "chantier", "lot", "note"];

const chantier = (data, id) => {
  const c = data.chantiers.find((x) => x.id === id);
  if (!c) throw new Error(`chantier inconnu : ${id}`);
  return c;
};
const tache = (data, id) => {
  const t = data.items.find((x) => x.id === id);
  if (!t) throw new Error(`tâche inconnue : ${id}`);
  return t;
};

/** Le numéro suivant après le plus grand de `ids` qui portent `prefixe` (« CH-03 », « API-04 »). */
function suivant(prefixe, ids) {
  const nums = ids.map((i) => i.match(new RegExp(`^${prefixe}-(\\d+)`))).filter(Boolean).map((m) => Number(m[1]));
  return `${prefixe}-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(2, "0")}`;
}

function verifier(champs, permis, quoi) {
  for (const k of Object.keys(champs)) if (!permis.includes(k)) throw new Error(`champ non modifiable sur ${quoi} : ${k}`);
  if ("priorite" in champs && !PRIOS.includes(champs.priorite)) throw new Error(`priorité invalide : ${champs.priorite}`);
  if ("statut" in champs && !STATUTS.includes(champs.statut)) throw new Error(`statut invalide : ${champs.statut}`);
  if ("titre" in champs && !String(champs.titre || "").trim()) throw new Error("titre vide");
}

export function creerChantier(data, { id, titre, etat = "pas commencé", prochaine_action = "", decisions = "", doc = "", priorite = "P2", maj = "" } = {}) {
  if (!String(titre || "").trim()) throw new Error("titre du chantier attendu");
  const cid = id || suivant("CH", data.chantiers.map((c) => c.id));
  if (!ID_CHANTIER.test(cid)) throw new Error(`id de chantier invalide : ${cid} (CH-nn)`);
  if (data.chantiers.some((c) => c.id === cid)) throw new Error(`id déjà pris : ${cid}`);
  verifier({ priorite }, CHAMPS_CHANTIER, "un chantier");
  const rang = Math.max(0, ...data.chantiers.map((c) => Number(c.rang) || 0)) + 1;
  data.chantiers.push({ id: cid, titre: String(titre).trim(), etat, colonne: etatColonne(etat), prochaine_action, decisions, doc, maj, priorite, rang, note: "", lots: [] });
  return cid;
}

export function modifierChantier(data, id, champs) {
  verifier(champs, CHAMPS_CHANTIER, "un chantier");
  const c = chantier(data, id);
  Object.assign(c, champs);
  if ("etat" in champs) c.colonne = etatColonne(champs.etat);
}

/** Clôture (ou abandon) : le chantier passe dans « Terminés & clos » avec sa preuve. */
export function cloreChantier(data, id, { preuve = "", reste = "", le, abandon = false } = {}) {
  if (!le) throw new Error("date de clôture attendue");
  const c = chantier(data, id);
  const col = abandon ? "abandonne" : "clos";
  Object.assign(c, { etat: col, colonne: col, clos_le: le, maj: le, preuve, reste });
}

export function creerTache(data, { id, chantier: cid, titre, constat = "", attendu = "", domaine, priorite = "P2", decision = false } = {}) {
  if (!String(titre || "").trim()) throw new Error("titre de la tâche attendu");
  if (cid) chantier(data, cid);
  // Domaine : celui donné, sinon le plus fréquent parmi les tâches du chantier.
  const doms = data.items.filter((i) => cid && i.chantier === cid).map((i) => i.domaine);
  const dom = domaine || doms.sort((a, b) => doms.filter((d) => d === b).length - doms.filter((d) => d === a).length)[0];
  if (!dom && !id) throw new Error("domaine attendu (préfixe de l'id, ex. API)");
  const tid = id || suivant(dom, data.items.map((i) => i.id));
  if (!ID_TACHE.test(tid)) throw new Error(`id de tâche invalide : ${tid} (ex. API-04)`);
  if (data.items.some((i) => i.id === tid)) throw new Error(`id déjà pris : ${tid}`);
  verifier({ priorite }, CHAMPS_TACHE, "une tâche");
  data.items.push({
    id: tid, titre: String(titre).trim(), constat, attendu, domaine: dom || tid.split("-")[0], section: "", ligne: null,
    decision: Boolean(decision), lot_spec: null, priorite, chantier: cid || null, statut: "a_faire", note: "", lot: null,
  });
  return tid;
}

export function modifierTache(data, id, champs) {
  verifier(champs, CHAMPS_TACHE, "une tâche");
  const t = tache(data, id);
  if (champs.chantier) chantier(data, champs.chantier);
  Object.assign(t, champs);
  if ("decision" in champs) t.decision = Boolean(champs.decision);
  if ("chantier" in champs) { t.chantier = champs.chantier || null; if (!("lot" in champs)) t.lot = null; }
}

export function ajouterJournal(data, { date, session, chantiers = "", texte, commits = "—", docs = "—" } = {}) {
  if (!date || !session || !String(texte || "").trim()) throw new Error("journal : date, session et texte attendus");
  data.journal ||= { consigne: "", entrees: [] };
  data.journal.entrees.push({ date, session, chantiers, texte: String(texte).trim(), commits, docs });
}

/**
 * Lots venus des specs envoyées par la commande d'un projet ({ chemin, texte }) : un chantier
 * dont la colonne « doc » cite le nom de la spec reçoit ses lots, et ses tâches leur lot_spec.
 */
export function poserLots(data, specs) {
  for (const c of data.chantiers) {
    const spec = specs.find((s) => String(c.doc || "").includes(s.chemin.split("/").pop()));
    if (!spec) continue;
    const own = data.items.filter((i) => i.chantier === c.id);
    rattacherLots(c, spec.texte, own);
    for (const i of own) i.lot_spec = (c.lots.find((l) => l.taches.includes(i.id)) || {}).id || null;
  }
}
