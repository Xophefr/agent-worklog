// BFF du mode base : le seul à parler à la base (PostgreSQL, MySQL, MariaDB). Il sert, pour chaque
// projet en base, le tableau (même interface qu'en mode fichiers) et une API.
//
//   npm run bff                               # http://localhost:4180/ (réglage ~/.agent-worklog/bff.json)
//   npm run bff -- --port 4181
//   npm run bff -- jeton interface            # jeton de l'accueil (relais de l'interface)
//   npm run bff -- jeton <projet>             # jeton d'un projet (commandes des sessions)
//
// Réglage : ~/.agent-worklog/bff.json { "base": "postgres://…", "port": 4180 } ; WORKLOG_BASE_URL
// et WORKLOG_BFF_PORT priment. Toute requête : hôte local et jeton (Authorization: Bearer). Un
// jeton de projet ne voit et n'écrit que son projet, et chaque écriture nomme sa session ; le jeton
// d'interface (l'accueil) voit tout et signe du nom passé dans X-Worklog-Auteur.
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applySession } from "./chantiers-tracker.mjs";
import { exportMd } from "./export-md.mjs";
import { fail, isLocalHost, readBody, send, serveFile } from "./http.mjs";
import { applyPatch } from "./patch.mjs";
import { ajouterJournal, cloreChantier, creerChantier, creerTache, modifierChantier, modifierTache, poserLots } from "./operations.mjs";
import { summarize } from "./resume.mjs";
import { ouvrirBase } from "./base/connexion.mjs";
import { creerDepot, ErreurDepot, importer } from "./base/depot.mjs";
import { migrer } from "./base/schema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "..");
const UI = new Set(["index.html", "app.js", "style.css", "xlsx.js"]);
const jourLocal = () => new Date().toLocaleDateString("en-CA");

// Les opérations qu'une écriture peut demander : (données, args, session) -> résultat.
const OPERATIONS = {
  creerChantier: (d, a) => creerChantier(d, a),
  modifierChantier: (d, a) => modifierChantier(d, a.id, a.champs || {}, a.base),
  cloreChantier: (d, a) => cloreChantier(d, a.id, { ...a, le: a.le || jourLocal() }),
  creerTache: (d, a) => creerTache(d, a),
  modifierTache: (d, a) => modifierTache(d, a.id, a.champs || {}, a.base),
  ajouterJournal: (d, a, s) => ajouterJournal(d, { date: jourLocal(), session: s, ...a }),
  session: (d, a, s) => applySession(d, a, s, a.jour || jourLocal()),
  reglages: (d, a) => { d.reglages = { ...d.reglages, ...a }; },
  specs: (d, a) => {
    for (const s of a.specs || []) { const k = d.specs.findIndex((x) => x.chemin === s.chemin); if (k >= 0) d.specs[k] = s; else d.specs.push(s); }
    poserLots(d, a.specs || []);
  },
  code: (d, a) => { d.code = a.stats || null; },
};

/** Ce que reçoit le tableau : la forme de chantiers.json, sans les gros textes (servis à part). */
function pourTableau(d) {
  const { specs, textes, code, ...reste } = d;
  return { ...reste, meta: { ...d.meta, specs: specs.map((s) => s.chemin), code: Boolean(code) } };
}

export function createBff({ depot, uiDir = join(SRC, "docs", "tracker"), outil = "" }) {
  async function qui(req) {
    const m = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization || ""));
    const j = m ? await depot.verifierJeton(m[1].trim()) : null;
    if (!j) return null;
    if (j.projetId) return { projet: j.projetId, type: "session" };
    let nom = "interface";
    try { nom = decodeURIComponent(String(req.headers["x-worklog-auteur"] || "")) || "interface"; } catch { /* en-tête mal encodé : nom par défaut */ }
    return { projet: null, type: "interface", nom };
  }
  const voit = (acces, projet) => acces.projet === null || acces.projet === projet;
  const auteurDe = (acces, session) => (acces.type === "session" ? { nom: session, type: "session" } : { nom: acces.nom, type: "interface" });

  async function corps(req) {
    if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) throw new ErreurDepot(415, "JSON attendu");
    try { return JSON.parse(await readBody(req)) || {}; } catch { throw new ErreurDepot(400, "charge invalide"); }
  }

  async function route(req, res) {
    if (!isLocalHost(req)) return fail(res, 403, "hôte refusé");
    const u = new URL(req.url, "http://localhost");
    const acces = await qui(req);
    if (!acces) return fail(res, 401, "jeton absent ou inconnu");
    const p = decodeURIComponent(u.pathname);

    if (p === "/api/projets") {
      if (req.method === "POST") {
        if (acces.type !== "interface") return fail(res, 403, "réservé à l'interface");
        const c = await corps(req);
        await depot.creerProjet({ id: c.id, nom: c.nom || c.id, ui: c.ui || {} }, auteurDe(acces));
        return send(res, 200, { ok: true, jeton: await depot.creerJeton(c.id, "poste") });
      }
      const projets = [];
      for (const pr of await depot.projets()) {
        if (!voit(acces, pr.id)) continue;
        const d = await depot.lire(pr.id);
        projets.push({ id: pr.id, nom: pr.nom, resume: summarize(d, { today: jourLocal(), version: outil, outil }) });
      }
      return send(res, 200, { ok: true, projets });
    }
    if (p === "/api/import") {
      if (req.method !== "POST") return fail(res, 405, "POST attendu");
      if (acces.type !== "interface") return fail(res, 403, "réservé à l'interface (accueil ou installation)");
      const c = await corps(req);
      await importer(depot, c, { nom: "import", type: "session" }, { remplacer: Boolean(c.remplacer) });
      return send(res, 200, { ok: true, jeton: await depot.creerJeton(c.id, "poste") });
    }

    const api = /^\/api\/p\/([^/]+)\/(operation|historique|spec|export)$/.exec(p);
    const tab = /^\/p\/([^/]+)(\/(.*))?$/.exec(p);
    const projet = api ? api[1] : tab ? tab[1] : null;
    if (!projet) return fail(res, 404, "introuvable");
    if (!voit(acces, projet)) return fail(res, 403, "jeton d'un autre projet");

    if (api) {
      const quoi = api[2];
      if (quoi === "operation") {
        if (req.method !== "POST") return fail(res, 405, "POST attendu");
        const c = await corps(req);
        const f = OPERATIONS[c.op];
        if (!f) return fail(res, 400, `opération inconnue : ${c.op}`);
        const session = String(c.session || "").trim();
        if (acces.type === "session" && !session) return fail(res, 400, "--session attendu : chaque écriture nomme sa session");
        // Une règle métier refusée par l'opération est une erreur de la demande (400), pas du serveur.
        const r = await depot.ecrire(projet, auteurDe(acces, session), (d) => {
          try { return f(d, c.args || {}, session || acces.nom); } catch (e) { throw new ErreurDepot(400, e.message); }
        });
        return send(res, 200, { ok: true, ...r });
      }
      if (quoi === "historique") return send(res, 200, { ok: true, lignes: await depot.historique(projet, u.searchParams.get("objet"), u.searchParams.get("id")) });
      const d = await depot.lire(projet);
      if (quoi === "spec") {
        const s = d.specs.find((x) => x.chemin === u.searchParams.get("chemin"));
        return s ? send(res, 200, { ok: true, chemin: s.chemin, texte: s.texte }) : fail(res, 404, "spec inconnue");
      }
      return send(res, 200, { ok: true, ...exportMd(d), textes: d.textes });
    }

    const rest = tab[2] === undefined ? null : tab[3];
    if (rest === null) { res.writeHead(301, { Location: `/p/${projet}/` }); return res.end(); }
    if (rest === "save.php") {
      if (req.method !== "POST") return fail(res, 405, "POST attendu");
      const c = await corps(req);
      if (typeof c.patch !== "object" || c.patch === null) return fail(res, 400, "charge invalide (patch attendu)");
      const r = await depot.ecrire(projet, auteurDe(acces, String(c.session || "tableau")), (d) => applyPatch(d, c.patch));
      return send(res, 200, { ok: true, version: r.version, edition: null, conflicts: r.resultat.conflicts });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "lecture seule");
    if (rest === "" || UI.has(rest)) return serveFile(req, res, uiDir, rest || "index.html");
    if (rest === "chantiers.json") return send(res, 200, JSON.stringify(pourTableau(await depot.lire(projet))));
    if (rest === "code_stats.json") { const d = await depot.lire(projet); return d.code ? send(res, 200, JSON.stringify(d.code)) : fail(res, 404, "aucun relevé"); }
    return fail(res, 404, "introuvable");
  }

  return createServer((req, res) => {
    route(req, res).catch((e) => {
      if (res.headersSent) return;
      return fail(res, e instanceof ErreurDepot ? e.code : 500, e.message);
    });
  });
}

function reglage() {
  const f = join(process.env.AGENT_WORKLOG_HOME || join(homedir(), ".agent-worklog"), "bff.json");
  let r = {};
  if (existsSync(f)) { try { r = JSON.parse(readFileSync(f, "utf8")); } catch (e) { throw new Error(`bff.json illisible : ${e.message}`); } }
  return { base: process.env.WORKLOG_BASE_URL || r.base, port: Number(process.env.WORKLOG_BFF_PORT || r.port) || 4180, fichier: f };
}

async function main(argv) {
  const r = reglage();
  if (!r.base) { console.error(`ERREUR : aucune base réglée (WORKLOG_BASE_URL, ou "base" dans ${r.fichier})`); return 2; }
  const base = await ouvrirBase(r.base);
  await migrer(base);
  const depot = creerDepot(base);
  if (argv[0] === "jeton") {
    const cible = argv[1];
    if (!cible) { console.error("Usage : npm run bff -- jeton interface|<projet>"); await base.fermer(); return 2; }
    if (cible !== "interface" && !(await depot.projets()).some((p) => p.id === cible)) { console.error(`projet inconnu : ${cible}`); await base.fermer(); return 1; }
    console.log(await depot.creerJeton(cible === "interface" ? null : cible, cible === "interface" ? "interface" : "poste"));
    await base.fermer();
    return 0;
  }
  const k = argv.indexOf("--port");
  const port = Number(k >= 0 ? argv[k + 1] : r.port) || 4180;
  const outil = JSON.parse(readFileSync(join(SRC, "package.json"), "utf8")).version;
  createBff({ depot, outil }).listen(port, "127.0.0.1", () => {
    console.log(`BFF : http://localhost:${port}/ (base ${base.dialecte === "pg" ? "PostgreSQL" : "MySQL/MariaDB"})`);
    console.log("Ctrl+C pour arrêter.");
  });
  return null;
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main(process.argv.slice(2)).then((c) => { if (c !== null) process.exitCode = c; }, (e) => { console.error(`ERREUR : ${e.message}`); process.exitCode = 1; });
}
