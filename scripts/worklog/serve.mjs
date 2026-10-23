// Sert le tableau de suivi sans WAMP ni PHP : `npm run tracker`, puis ouvrir l'adresse affichée.
//
// Écoute sur 127.0.0.1 seulement. Sert les fichiers du projet en lecture (les liens du
// tableau vers les docs et les specs marchent), jamais un chemin dont un segment commence
// par un point (.env, .git…). Seule écriture : POST <tracker>/save.php, au même protocole que
// docs/tracker/save.php (patch.mjs), réservée à une page du tableau lui-même.
//
//   npm run tracker                       # port du réglage (serveur.port, 4173 par défaut)
//   npm run tracker -- --port 8080
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { at, findRoot, loadConfig } from "./config.mjs";
import { fail, readBody, savePatch, send, serveFile, writeGuard } from "./http.mjs";

export function createTracker(root, cfg) {
  const trackerUrl = "/" + String(cfg.tracker).replace(/^\/+|\/+$/g, "") + "/";
  const dataFile = join(at(root, cfg, "tracker"), "chantiers.json");
  let queue = Promise.resolve(); // une écriture à la fois

  function save(req, res, raw) {
    let input;
    try { input = JSON.parse(raw); } catch { return fail(res, 400, "charge invalide"); }
    if (!input || typeof input.patch !== "object" || input.patch === null) return fail(res, 400, "charge invalide (patch attendu)");
    let r;
    try { r = savePatch(dataFile, input.patch); } catch (e) { return fail(res, 500, e.message); }
    return send(res, 200, { ok: true, ...r });
  }

  return createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch { return fail(res, 400, "adresse invalide"); }
    if (pathname === "/") { res.writeHead(302, { Location: trackerUrl }); return res.end(); }
    if (pathname === trackerUrl + "save.php") {
      if (req.method !== "POST") return fail(res, 405, "POST attendu");
      const refus = writeGuard(req);
      if (refus) return fail(res, refus.code, refus.error);
      readBody(req).then((raw) => { queue = queue.then(() => save(req, res, raw)).catch((e) => fail(res, 500, e.message)); }, (e) => fail(res, e.code === 413 ? 413 : 400, e.message));
      return undefined;
    }
    if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "lecture seule");
    return serveFile(req, res, root, pathname);
  });
}

function main() {
  const root = findRoot();
  const cfg = loadConfig(root);
  const argv = process.argv.slice(2);
  const k = argv.indexOf("--port");
  const port = Number(k >= 0 ? argv[k + 1] : cfg.serveur.port) || 4173;
  if (cfg.mode === "base") {
    console.log(`Ce projet est en mode base : son tableau est servi par le BFF (${cfg.bff}), ouvert depuis l'accueil (npm run accueil, dans agent-worklog).`);
    return;
  }
  if (!existsSync(join(at(root, cfg, "tracker"), "chantiers.json"))) {
    console.log("chantiers.json absent : lancer d'abord `npm run chantiers`.");
  }
  createTracker(root, cfg).listen(port, "127.0.0.1", () => {
    console.log(`Tableau de suivi : http://localhost:${port}/${String(cfg.tracker).replace(/^\/+|\/+$/g, "")}/`);
    console.log("Ctrl+C pour arrêter.");
  });
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) main();
