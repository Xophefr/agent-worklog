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
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { at, findRoot, loadConfig } from "./config.mjs";
import { applyPatch } from "./patch.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
};
const HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_BODY = 2_000_000;

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const fail = (res, code, error) => send(res, code, { ok: false, error });

export function createTracker(root, cfg) {
  const trackerUrl = "/" + String(cfg.tracker).replace(/^\/+|\/+$/g, "") + "/";
  const dataFile = join(at(root, cfg, "tracker"), "chantiers.json");
  let queue = Promise.resolve(); // une écriture à la fois

  function save(req, res, raw) {
    const host = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
    if (!HOSTS.has(host) || req.headers["x-forwarded-for"]) return fail(res, 403, "écriture réservée au poste local");
    // Pas d'écriture depuis une autre page ouverte dans le navigateur (CSRF) : le JSON impose une
    // requête de contrôle que le navigateur ne passe pas sans CORS, Sec-Fetch-Site dit d'où vient l'appel.
    if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return fail(res, 415, "JSON attendu");
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin") return fail(res, 403, "appel depuis une autre page refusé");
    let input;
    try { input = JSON.parse(raw); } catch { return fail(res, 400, "charge invalide"); }
    if (!input || typeof input.patch !== "object" || input.patch === null) return fail(res, 400, "charge invalide (patch attendu)");
    let cur;
    try { cur = JSON.parse(readFileSync(dataFile, "utf8")); } catch { return fail(res, 500, "chantiers.json illisible"); }
    if (!cur.meta || cur.meta.version === undefined) return fail(res, 500, "chantiers.json illisible");
    const { written, conflicts } = applyPatch(cur, input.patch);
    if (written) {
      cur.meta.version = Number(cur.meta.version) + 1;
      cur.meta.edition = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      try { copyFileSync(dataFile, dataFile + ".bak"); } catch { /* première écriture */ }
      writeFileSync(dataFile, JSON.stringify(cur, null, 4) + "\n", "utf8");
    }
    send(res, 200, { ok: true, version: cur.meta.version, edition: cur.meta.edition ?? null, conflicts });
  }

  function serveFile(req, res, pathname) {
    const parts = pathname.split("/").filter(Boolean);
    if (parts.some((p) => p.startsWith(".") || p.includes("\\"))) return fail(res, 404, "introuvable");
    let p = resolve(root, ...parts);
    if (p !== root && !p.startsWith(root + sep)) return fail(res, 404, "introuvable");
    if (existsSync(p) && statSync(p).isDirectory()) {
      if (!pathname.endsWith("/")) { res.writeHead(301, { Location: pathname + "/" }); return res.end(); }
      p = join(p, "index.html");
    }
    if (!existsSync(p) || !statSync(p).isFile()) return fail(res, 404, "introuvable");
    send(res, 200, req.method === "HEAD" ? "" : readFileSync(p), TYPES[extname(p).toLowerCase()] || "application/octet-stream");
  }

  return createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch { return fail(res, 400, "adresse invalide"); }
    if (pathname === "/") { res.writeHead(302, { Location: trackerUrl }); return res.end(); }
    if (pathname === trackerUrl + "save.php") {
      if (req.method !== "POST") return fail(res, 405, "POST attendu");
      const chunks = [];
      let size = 0;
      req.on("data", (c) => { size += c.length; if (size > MAX_BODY) req.destroy(); else chunks.push(c); });
      req.on("end", () => { queue = queue.then(() => save(req, res, Buffer.concat(chunks).toString("utf8"))).catch((e) => fail(res, 500, e.message)); });
      return undefined;
    }
    if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "lecture seule");
    return serveFile(req, res, pathname);
  });
}

function main() {
  const root = findRoot();
  const cfg = loadConfig(root);
  const argv = process.argv.slice(2);
  const k = argv.indexOf("--port");
  const port = Number(k >= 0 ? argv[k + 1] : cfg.serveur.port) || 4173;
  if (!existsSync(join(at(root, cfg, "tracker"), "chantiers.json"))) {
    console.log("chantiers.json absent : lancer d'abord `npm run chantiers`.");
  }
  createTracker(root, cfg).listen(port, "127.0.0.1", () => {
    console.log(`Tableau de suivi : http://localhost:${port}/${String(cfg.tracker).replace(/^\/+|\/+$/g, "")}/`);
    console.log("Ctrl+C pour arrêter.");
  });
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) main();
