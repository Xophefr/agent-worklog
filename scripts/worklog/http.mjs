// Garde-fous HTTP communs au serveur d'un projet (serve.mjs) et au serveur d'accueil (accueil.mjs).
//
// Lecture : jamais un chemin dont un segment commence par un point (.env, .git…), jamais hors
// du dossier servi. Écriture : poste local, corps JSON, appel venu de la page elle-même.
import { copyFileSync, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { applyPatch } from "./patch.mjs";

export const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
const HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const MAX_BODY = 2_000_000;

// Pages du tableau et de l'accueil : scripts et données de leur seule origine. Un texte venu de la base qui
// échapperait un jour à l'échappement ne pourrait ni lancer de script, ni rien envoyer ailleurs.
// (Les attributs style="…" du rendu demandent 'unsafe-inline' pour les styles seulement.)
export const CSP_PAGE = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; "
  + "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

// Fichiers d'un projet servis en lecture (accueil /p/<id>/fichiers/, npm run tracker) : les seuls types que le
// tableau relie (docs, specs, code cité) et ses propres fichiers ; jamais un nom qui sent le secret, jamais node_modules.
const EXT_PROJET = new Set([".md", ".txt", ".json", ".yml", ".yaml", ".html", ".css", ".js", ".mjs", ".cjs", ".ts", ".py", ".php", ".ps1", ".sh", ".conf", ".sql", ".svg", ".png", ".jpg", ".ico", ".woff2"]);
const NOM_SECRET = /secret|credential|passw|private[-_.]?key|id_rsa|id_ed25519|\.pem$|\.key$|\.p12$|\.pfx$/i;

export function send(res, code, body, type = "application/json; charset=utf-8", headers = {}) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
export const fail = (res, code, error, details) => send(res, code, { ok: false, error, ...details });

const gz = promisify(gzip);
/** Comme send, compressé en gzip quand le client l'accepte et que le corps en vaut la peine (données du tableau). */
export async function sendz(req, res, code, body, type = "application/json; charset=utf-8", headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
  if (buf.length < 4096 || !/\bgzip\b/i.test(String(req.headers["accept-encoding"] || ""))) return send(res, code, buf, type, headers);
  return send(res, code, await gz(buf, { level: 6 }), type, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
}

/** 304 si la page a déjà cette version (en-tête If-None-Match) ; sinon false, et l'appelant envoie le corps. */
export function pasChange(req, res, etag) {
  if (!etag || String(req.headers["if-none-match"] || "") !== etag) return false;
  res.writeHead(304, { ETag: etag, "Cache-Control": "no-store" });
  res.end();
  return true;
}
/** Empreinte faible d'un fichier : taille et date de modification. */
export const etagFichier = (st) => `W/"${st.size.toString(36)}-${Math.trunc(st.mtimeMs).toString(36)}"`;

/** Requête adressée au poste local (Host) : refuse une page tierce qui passerait par un nom rebondi vers 127.0.0.1. */
export function isLocalHost(req) {
  return HOSTS.has(String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "")) && !req.headers["x-forwarded-for"];
}

const dedans = (racine, p) => p === racine || p.startsWith(racine + sep);

/**
 * Sert `relPath` (décodé, relatif à `root`) ; 404 pour un fichier caché, une sortie du dossier (y compris par
 * un lien symbolique) ou un absent. `projet` : fichiers d'un projet, filtrés (types reliés, aucun nom de secret).
 * Une page HTML reçoit la politique CSP_PAGE, sauf en-tête Content-Security-Policy fourni (bac à sable).
 */
export function serveFile(req, res, root, relPath, headers = {}, { projet = false } = {}) {
  const parts = relPath.split("/").filter(Boolean);
  if (parts.some((p) => p.startsWith(".") || p.includes("\\"))) return fail(res, 404, "introuvable");
  root = resolve(root);
  let p = resolve(root, ...parts);
  if (!dedans(root, p)) return fail(res, 404, "introuvable");
  if (existsSync(p) && statSync(p).isDirectory()) {
    if (!req.url.split("?")[0].endsWith("/")) { res.writeHead(301, { Location: req.url.split("?")[0] + "/" }); return res.end(); }
    p = join(p, "index.html");
  }
  if (!existsSync(p) || !statSync(p).isFile()) return fail(res, 404, "introuvable");
  let reel;
  try { reel = realpathSync(p); if (!dedans(realpathSync(root), reel)) return fail(res, 404, "introuvable"); } catch { return fail(res, 404, "introuvable"); }
  const ext = extname(reel).toLowerCase();
  if (projet && (!EXT_PROJET.has(ext) || NOM_SECRET.test(basename(reel)) || parts.includes("node_modules"))) return fail(res, 404, "introuvable");
  const st = statSync(reel);
  const etag = etagFichier(st);
  if (pasChange(req, res, etag)) return undefined;
  const h = { ETag: etag, ...(ext === ".html" && !Object.keys(headers).some((k) => k.toLowerCase() === "content-security-policy") ? { "Content-Security-Policy": CSP_PAGE } : {}), ...headers };
  return send(res, 200, req.method === "HEAD" ? "" : readFileSync(reel), TYPES[ext] || "application/octet-stream", h);
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

/**
 * Corps de la requête, refusé au-delà de `max` octets : la suite est lue sans être gardée, pour
 * pouvoir répondre 413 (couper la connexion faisait croire à un serveur injoignable).
 */
export function readBody(req, max = MAX_BODY) {
  return new Promise((ok, ko) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size <= max) chunks.push(c); });
    req.on("end", () => (size > max ? ko(Object.assign(new Error(`charge trop grande (${size} octets, limite ${max})`), { code: 413 })) : ok(Buffer.concat(chunks).toString("utf8"))));
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
