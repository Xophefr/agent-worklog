// Garde-fous HTTP communs au serveur d'un projet (serve.mjs) et au serveur d'accueil (accueil.mjs).
//
// Lecture : jamais un chemin dont un segment commence par un point (.env, .git…), jamais hors
// du dossier servi. Écriture : poste local, corps JSON, appel venu de la page elle-même.
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { applyPatch } from "./patch.mjs";

export const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
};
const HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const MAX_BODY = 2_000_000;

export function send(res, code, body, type = "application/json; charset=utf-8", headers = {}) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
export const fail = (res, code, error) => send(res, code, { ok: false, error });

/** Requête adressée au poste local (Host) : refuse une page tierce qui passerait par un nom rebondi vers 127.0.0.1. */
export function isLocalHost(req) {
  return HOSTS.has(String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "")) && !req.headers["x-forwarded-for"];
}

/** Sert `relPath` (décodé, relatif à `root`) ; 404 pour un fichier caché, une sortie du dossier ou un absent. */
export function serveFile(req, res, root, relPath, headers = {}) {
  const parts = relPath.split("/").filter(Boolean);
  if (parts.some((p) => p.startsWith(".") || p.includes("\\"))) return fail(res, 404, "introuvable");
  root = resolve(root);
  let p = resolve(root, ...parts);
  if (p !== root && !p.startsWith(root + sep)) return fail(res, 404, "introuvable");
  if (existsSync(p) && statSync(p).isDirectory()) {
    if (!req.url.split("?")[0].endsWith("/")) { res.writeHead(301, { Location: req.url.split("?")[0] + "/" }); return res.end(); }
    p = join(p, "index.html");
  }
  if (!existsSync(p) || !statSync(p).isFile()) return fail(res, 404, "introuvable");
  return send(res, 200, req.method === "HEAD" ? "" : readFileSync(p), TYPES[extname(p).toLowerCase()] || "application/octet-stream", headers);
}

/** Refus d'une écriture, ou null si elle est admise : { code, error }. */
export function writeGuard(req) {
  if (!isLocalHost(req)) return { code: 403, error: "écriture réservée au poste local" };
  // Pas d'écriture depuis une autre page ouverte dans le navigateur (CSRF) : le JSON impose une
  // requête de contrôle que le navigateur ne passe pas sans CORS, Sec-Fetch-Site dit d'où vient l'appel.
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return { code: 415, error: "JSON attendu" };
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin") return { code: 403, error: "appel depuis une autre page refusé" };
  return null;
}

/** Corps de la requête, refusé au-delà de `max` octets. */
export function readBody(req, max = MAX_BODY) {
  return new Promise((ok, ko) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > max) { req.destroy(); ko(new Error("charge trop grande")); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", ko);
  });
}

/** Applique un patch du tableau à `dataFile` (chantiers.json) : version, date d'édition, copie .bak. */
export function savePatch(dataFile, patch) {
  let cur;
  try { cur = JSON.parse(readFileSync(dataFile, "utf8")); } catch { throw new Error("chantiers.json illisible"); }
  if (!cur.meta || cur.meta.version === undefined) throw new Error("chantiers.json illisible");
  const { written, conflicts } = applyPatch(cur, patch);
  if (written) {
    cur.meta.version = Number(cur.meta.version) + 1;
    cur.meta.edition = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    try { copyFileSync(dataFile, dataFile + ".bak"); } catch { /* première écriture */ }
    writeFileSync(dataFile, JSON.stringify(cur, null, 4) + "\n", "utf8");
  }
  return { version: cur.meta.version, edition: cur.meta.edition ?? null, conflicts };
}
