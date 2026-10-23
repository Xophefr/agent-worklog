// Résumé d'un projet pour sa carte de l'accueil, calculé depuis son chantiers.json.
// Même lecture que le tableau (app.js) : base = tâches hors abandonnées, décision attendue =
// tâche marquée et ni faite ni abandonnée. Un champ absent (ancienne version) compte pour rien.

const FERMES = new Set(["termine", "clos", "abandonne"]);
const JOUR = /^(\d{4}-\d{2}-\d{2})/;

/** Le jour `n` jours avant `jour` (AAAA-MM-JJ). */
function avant(jour, n) {
  const d = new Date(jour + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function summarize(data, { today, version = null, outil }) {
  const meta = data.meta || {};
  const ui = meta.ui || {};
  const items = data.items || [];
  const chantiers = data.chantiers || [];

  const taches = { a_faire: 0, en_cours: 0, a_verifier: 0, fait: 0, abandonne: 0 };
  for (const i of items) if (taches[i.statut] !== undefined) taches[i.statut] += 1;
  taches.base = items.length - taches.abandonne;
  taches.pct = taches.base ? Math.round((taches.fait / taches.base) * 100) : 0;

  const ouverts = chantiers.filter((c) => !FERMES.has(c.colonne));
  const debut = avant(today, 6); // 7 jours, aujourd'hui compris
  let bouges7j = 0;
  let derniere = null;
  for (const i of items) {
    const m = JOUR.exec(i.suivi || "");
    if (!m) continue;
    if (m[1] >= debut && m[1] <= today) bouges7j += 1;
    if (!derniere || m[1] > derniere) derniere = m[1];
  }

  return {
    nom: meta.projet || "",
    accent: ui.accent || null,
    accentSombre: ui.accentSombre || null,
    taches,
    chantiers: { ouverts: ouverts.length, en_cours: ouverts.filter((c) => c.colonne === "en_cours").length, bloque: ouverts.filter((c) => c.colonne === "bloque").length },
    decisions: items.filter((i) => i.decision && !["fait", "abandonne"].includes(i.statut)).length,
    bouges7j,
    derniere,
    version,
    aJour: version !== null && version === outil,
  };
}
