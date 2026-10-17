// Enregistrement des champs que le tableau pilote : même protocole que docs/tracker/save.php,
// pour le serveur Node (serve.mjs). Les deux doivent rester d'accord.
//
// Le tableau n'envoie QUE les champs qu'on a touchés, avec la valeur qu'ils avaient au
// chargement (`base`). Un champ s'écrit si le fichier porte encore cette valeur ; sinon il
// part dans `conflicts` et rien n'est écrasé. C'est un verrou par CHAMP : une session qui
// passe `npm run chantiers` pendant qu'on édite ne fait perdre aucune saisie.
//
// Champs écrits : priorité, rang et note d'un chantier ; statut, priorité, note,
// rattachement et lot d'une tâche. L'état d'un chantier (CHANTIERS.md) ne s'écrit jamais ici.
export const PRIOS = ["P0", "P1", "P2", "P3"];
export const STATUTS = ["a_faire", "en_cours", "a_verifier", "fait", "abandonne"];

const note = (v) => [...(typeof v === "string" ? v : "")].slice(0, 4000).join("");
/** Deux valeurs sont « la même » pour le verrou par champ (null et '' sont un vide commun). */
const norm = (v) => (v === null || v === undefined || v === "" ? null : typeof v === "number" ? String(v) : v);
const same = (a, b) => norm(a) === norm(b);

/**
 * Applique `patch` ({chantiers: [{id, set, base}], items: [...]}) à `cur` (le JSON lu).
 * Modifie `cur` en place ; rend {written, conflicts}. N'incrémente pas la version.
 */
export function applyPatch(cur, patch) {
  const conflicts = [];
  let written = 0;
  const chIds = new Set(cur.chantiers.map((c) => c.id));
  const lotIds = new Map(cur.chantiers.map((c) => [c.id, new Set((c.lots || []).map((l) => String(l.id)))]));

  const apply = (row, kind, field, value, base, checked) => {
    if (!checked) return false; // valeur refusée par la validation
    if (Object.hasOwn(base, field) && !same(row[field], base[field])) {
      conflicts.push({ kind, id: row.id, champ: field, actuel: row[field] ?? null });
      return false;
    }
    row[field] = value;
    written += 1;
    return true;
  };
  const byId = (list) => new Map((Array.isArray(list) ? list : []).filter((p) => p && typeof p === "object" && p.id).map((p) => [p.id, p]));
  const parts = (p) => [p.set && typeof p.set === "object" ? p.set : {}, p.base && typeof p.base === "object" ? p.base : {}];

  const pCh = byId(patch.chantiers);
  for (const c of cur.chantiers) {
    const p = pCh.get(c.id);
    if (!p) continue;
    const [set, base] = parts(p);
    for (const [f, v] of Object.entries(set)) {
      if (f === "priorite") apply(c, "chantier", f, v, base, PRIOS.includes(v));
      else if (f === "rang") apply(c, "chantier", f, v, base, Number.isInteger(v) && v > 0);
      else if (f === "note") apply(c, "chantier", f, note(v), base, true);
    }
  }

  const pIt = byId(patch.items);
  for (const it of cur.items) {
    const p = pIt.get(it.id);
    if (!p) continue;
    const [set, base] = parts(p);
    for (const [f, v] of Object.entries(set)) {
      if (f === "statut") apply(it, "tache", f, v, base, STATUTS.includes(v));
      else if (f === "priorite") apply(it, "tache", f, v, base, PRIOS.includes(v));
      else if (f === "note") apply(it, "tache", f, note(v), base, true);
      else if (f === "chantier") {
        const vide = v === null || v === "";
        // Un détachement VOULU laisse sa trace (`detache`) : sans elle, chantiers-tracker
        // rattacherait de nouveau la tâche à son chantier par défaut au passage suivant.
        if (apply(it, "tache", f, vide ? null : v, base, vide || chIds.has(v))) {
          if (it.chantier === null) it.detache = true; else delete it.detache;
        }
      } else if (f === "lot") {
        const vide = v === null || v === "";
        const ok = vide || (typeof v === "string" && it.chantier && (lotIds.get(it.chantier) || new Set()).has(v));
        apply(it, "tache", f, vide ? null : v, base, ok);
      }
    }
  }
  return { written, conflicts };
}
