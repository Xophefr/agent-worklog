// Export Markdown d'un projet en mode base : CHANTIERS.md et backlog, au format que lit le mode
// fichiers (parseChantiers, parseBacklog, parseJournal). Format canonique (tableaux) : la prose
// libre des fichiers d'origine n'est pas reconstituée (l'import en garde une copie brute).

// Une cellule : « | » échappé, retour à la ligne en <br> (convention du tableau), vide -> « — ».
const cell = (v) => {
  const t = String(v ?? "").replaceAll("|", "\\|").replace(/\r?\n/g, "<br>").trim();
  return t || "—";
};
const ligne = (vals) => `| ${vals.map(cell).join(" | ")} |`;
const tableau = (entete, rows) => [ligne(entete), `|${entete.map(() => "---").join("|")}|`, ...rows.map(ligne)].join("\n");

const FERMES = new Set(["termine", "clos", "abandonne"]);
const PRIOS = ["P0", "P1", "P2", "P3"];
const ordre = (a, b) => PRIOS.indexOf(a.priorite) - PRIOS.indexOf(b.priorite) || (a.rang || 0) - (b.rang || 0);
const parId = (a, b) => a.id.localeCompare(b.id, "fr", { numeric: true });

export function exportMd(data) {
  const chantiers = data.chantiers || [];
  const items = data.items || [];
  const marque = (data.meta && data.meta.ui && data.meta.ui.marque) || "DÉCISION";

  const ouverts = chantiers.filter((c) => !FERMES.has(c.colonne)).sort(ordre);
  // Un chantier « terminé » mais pas encore descendu reste dans les ouverts, comme en mode fichiers.
  const termines = chantiers.filter((c) => c.colonne === "termine").sort(ordre);
  const clos = chantiers.filter((c) => c.colonne === "clos" || c.colonne === "abandonne")
    .sort((a, b) => String(b.clos_le || "").localeCompare(String(a.clos_le || "")));
  const titreClos = (c) => (c.colonne === "abandonne" && !/abandonn/i.test(c.titre) ? `**ABANDONNÉ** ${c.titre}` : c.titre);

  const journal = data.journal || { consigne: "", entrees: [] };
  const lignesJournal = journal.entrees.map((e) => (e.brut ? null : [e.date, e.session, e.chantiers, e.texte, e.commits, e.docs])).filter(Boolean);
  const brut = journal.entrees.filter((e) => e.brut).map((e) => e.brut);

  const registre = [
    `# Chantiers${data.meta && data.meta.projet ? ` · ${data.meta.projet}` : ""}`,
    "",
    "## Chantiers ouverts",
    "",
    tableau(["id", "chantier", "état", "prochaine action", "décisions en attente", "doc de reprise", "MAJ"],
      [...ouverts, ...termines].map((c) => [c.id, c.titre, c.etat, c.prochaine_action, c.decisions, c.doc, c.maj])),
    "",
    "## Chantiers clos",
    "",
    tableau(["id", "chantier", "clos le", "preuve", "ce qui en reste"], clos.map((c) => [c.id, titreClos(c), c.clos_le, c.preuve, c.reste])),
    "",
    "## Journal",
    "",
    ...(journal.consigne ? [journal.consigne, ""] : []),
    tableau(["date", "session", "chantier", "ce qui a bougé", "commits", "docs touchés"], lignesJournal),
    ...(brut.length ? ["", ...brut] : []),
    "",
  ].join("\n");

  // Backlog : une section par chantier (ordre du registre), puis les tâches sans chantier.
  const tacheLigne = (t) => {
    const texte = `**${t.titre}.**${t.constat && t.constat !== t.titre ? ` ${t.constat}` : ""}`;
    return [t.id, t.priorite, t.decision && !texte.includes(marque) ? `${texte} ${marque}` : texte, t.attendu];
  };
  const section = (titre, list) => [`## ${titre}`, "", tableau(["id", "P", "tâche", "attendu"], list.sort(parId).map(tacheLigne)), ""];
  const parties = ["# Backlog", ""];
  for (const c of [...ouverts, ...termines, ...clos]) {
    const list = items.filter((t) => t.chantier === c.id);
    if (list.length) parties.push(...section(`${c.id} · ${c.titre}`, list));
  }
  const seules = items.filter((t) => !t.chantier || !chantiers.some((c) => c.id === t.chantier));
  if (seules.length) parties.push(...section("Sans chantier", seules));

  return { chantiers: registre, backlog: parties.join("\n") };
}
