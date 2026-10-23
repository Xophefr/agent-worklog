// Connexion à la base du BFF : PostgreSQL (pg), MySQL ou MariaDB (mysql2). Le pilote est chargé
// selon l'URL, seulement ici : il n'existe que dans le dépôt agent-worklog, jamais dans un projet.
//
// Le SQL des autres modules s'écrit avec « ? » ; il est traduit en $1, $2… pour PostgreSQL.

const pgSql = (sql) => { let n = 0; return sql.replace(/\?/g, () => `$${++n}`); };

/** Ouvre une base : { dialecte, requete(sql, params) -> lignes, transaction(fn(tx)) -> T, fermer() }. */
export async function ouvrirBase(url) {
  const proto = new URL(url).protocol.replace(/:$/, "");
  if (proto === "postgres" || proto === "postgresql") {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const req = (c) => async (sql, params = []) => (await c.query(pgSql(sql), params)).rows;
    return {
      dialecte: "pg",
      requete: req(pool),
      async transaction(fn) {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          const r = await fn({ dialecte: "pg", requete: req(c) });
          await c.query("COMMIT");
          return r;
        } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
      },
      fermer: () => pool.end(),
    };
  }
  if (proto === "mysql" || proto === "mariadb") {
    const mysql = await import("mysql2/promise");
    const pool = mysql.createPool({ uri: url.replace(/^mariadb:/, "mysql:"), connectionLimit: 10, charset: "utf8mb4", supportBigNumbers: true });
    const req = (c) => async (sql, params = []) => { const [rows] = await c.query(sql, params); return rows; };
    return {
      dialecte: "mysql",
      requete: req(pool),
      async transaction(fn) {
        const c = await pool.getConnection();
        try {
          await c.beginTransaction();
          const r = await fn({ dialecte: "mysql", requete: req(c) });
          await c.commit();
          return r;
        } catch (e) { await c.rollback().catch(() => {}); throw e; } finally { c.release(); }
      },
      fermer: () => pool.end(),
    };
  }
  throw new Error(`base non prise en charge : ${proto} (postgres://, mysql:// ou mariadb://)`);
}
