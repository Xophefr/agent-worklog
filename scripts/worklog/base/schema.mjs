// Schéma de la base du BFF, en migrations numérotées (table wl_schema). Idempotent : migrer()
// n'applique que les migrations absentes. Chaque chantier et chaque tâche est un document JSON
// (colonne `donnees`) : même lecture et même écriture sur les trois bases ; l'historique, lui,
// est tenu champ par champ par le dépôt (base/depot.mjs).

// Types propres à chaque base : clé (index utf8mb4 limité en MySQL), texte long, compteur.
const T = {
  pg: { cle: "VARCHAR(191)", texte: "TEXT", auto: "BIGSERIAL PRIMARY KEY", entier: "BIGINT", date: "VARCHAR(32)" },
  mysql: { cle: "VARCHAR(191)", texte: "LONGTEXT", auto: "BIGINT AUTO_INCREMENT PRIMARY KEY", entier: "BIGINT", date: "VARCHAR(32)" },
};
const fin = (d) => (d === "mysql" ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin" : "");

const MIGRATIONS = [
  (d, t) => [
    `CREATE TABLE IF NOT EXISTS wl_projets (id ${t.cle} PRIMARY KEY, nom ${t.texte} NOT NULL, ui ${t.texte}, reglages ${t.texte}, textes ${t.texte}, cree_le ${t.date})${fin(d)}`,
    `CREATE TABLE IF NOT EXISTS wl_jetons (empreinte VARCHAR(64) PRIMARY KEY, projet_id ${t.cle}, nom ${t.texte}, cree_le ${t.date})${fin(d)}`,
    `CREATE TABLE IF NOT EXISTS wl_chantiers (projet_id ${t.cle} NOT NULL, id ${t.cle} NOT NULL, ordre ${t.entier} NOT NULL, donnees ${t.texte} NOT NULL, PRIMARY KEY (projet_id, id))${fin(d)}`,
    `CREATE TABLE IF NOT EXISTS wl_taches (projet_id ${t.cle} NOT NULL, id ${t.cle} NOT NULL, ordre ${t.entier} NOT NULL, donnees ${t.texte} NOT NULL, PRIMARY KEY (projet_id, id))${fin(d)}`,
    `CREATE TABLE IF NOT EXISTS wl_journal (n ${t.auto}, projet_id ${t.cle} NOT NULL, donnees ${t.texte} NOT NULL)${fin(d)}`,
    `CREATE TABLE IF NOT EXISTS wl_specs (projet_id ${t.cle} NOT NULL, chemin ${t.cle} NOT NULL, texte ${t.texte} NOT NULL, PRIMARY KEY (projet_id, chemin))${fin(d)}`,
    `CREATE TABLE IF NOT EXISTS wl_code (projet_id ${t.cle} PRIMARY KEY, stats ${t.texte} NOT NULL)${fin(d)}`,
    `CREATE TABLE IF NOT EXISTS wl_historique (n ${t.auto}, projet_id ${t.cle} NOT NULL, objet VARCHAR(32) NOT NULL, objet_id ${t.cle} NOT NULL, champ VARCHAR(64) NOT NULL, avant ${t.texte}, apres ${t.texte}, auteur ${t.texte} NOT NULL, type_auteur VARCHAR(16) NOT NULL, quand ${t.date} NOT NULL)${fin(d)}`,
    `CREATE INDEX wl_historique_objet ON wl_historique (projet_id, objet, objet_id)`,
  ],
];

export const TABLES = ["wl_historique", "wl_code", "wl_specs", "wl_journal", "wl_taches", "wl_chantiers", "wl_jetons", "wl_projets", "wl_schema"];

export async function migrer(base) {
  const d = base.dialecte;
  await base.requete(`CREATE TABLE IF NOT EXISTS wl_schema (version ${T[d].entier} NOT NULL)${fin(d)}`);
  const rows = await base.requete("SELECT MAX(version) AS v FROM wl_schema");
  const faite = Number(rows[0] && rows[0].v) || 0;
  for (let k = faite; k < MIGRATIONS.length; k++) {
    await base.transaction(async (tx) => {
      for (const sql of MIGRATIONS[k](d, T[d])) await tx.requete(sql);
      await tx.requete("INSERT INTO wl_schema (version) VALUES (?)", [k + 1]);
    });
  }
}
