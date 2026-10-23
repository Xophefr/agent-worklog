// Accueil multi-projets : une seule adresse locale pour tous les projets inscrits au registre.
//
//   npm run accueil                          # http://localhost:4170/
//   npm run accueil -- --port 8080
//   node scripts/worklog/accueil.mjs ajouter <dossier> [--id <id>]
//   node scripts/worklog/accueil.mjs retirer <id>
//   node scripts/worklog/accueil.mjs liste
//
// Sert l'interface de CE dépôt (docs/tracker/, toujours la plus récente) avec les données de
// chaque projet : /p/<id>/ est le tableau du projet, /p/<id>/fichiers/ ses fichiers en lecture
// (mêmes refus que serve.mjs), /p/<id>/save.php ses écritures (même protocole, une file par
// projet). Le chantiers.json servi est complété à la volée (meta.accueil, liens vers les
// fichiers) ; le fichier du projet n'est réécrit que par un patch. Écoute sur 127.0.0.1.
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { at, CONFIG_FILE, loadConfig } from "./config.mjs";
import { installInto } from "./install.mjs";
import { fail, isLocalHost, readBody, savePatch, send, serveFile, writeGuard } from "./http.mjs";
import { addProject, loadRegistry, registryFile, removeProject, saveRegistry, slugId } from "./registre.mjs";
import { summarize } from "./resume.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "..");
const PORT = 4170;
const UI = new Set(["index.html", "app.js", "style.css", "xlsx.js"]);
const RACINE = new Set(["accueil.html", "accueil.js", "style.css"]);

const jourLocal = () => new Date().toLocaleDateString("en-CA"); // AAAA-MM-JJ, heure du poste
const lireJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const posix = (p) => p.replaceAll("\\", "/");

/** Ce que l'accueil sait d'un projet inscrit : réglage, fichier de données, ou l'erreur à montrer. */
function ouvrir(entree) {
  const dossier = resolve(entree.dossier);
  if (!existsSync(dossier)) return { erreur: "dossier introuvable" };
  let cfg;
  try { cfg = loadConfig(dossier); } catch (e) { return { erreur: e.message }; }
  const tracker = at(dossier, cfg, "tracker");
  const dataFile = join(tracker, "chantiers.json");
  if (!existsSync(dataFile)) return { dossier, cfg, tracker, erreur: "chantiers.json absent : lancer npm run chantiers" };
  return { dossier, cfg, tracker, dataFile };
}

/**
 * Inscrit un projet depuis la page d'accueil. Deux cas :
 *  - « nouveau » : le dossier (créé s'il manque) reçoit l'outil, un réglage au nom donné et les
 *    modèles (registre, backlog, spec d'exemple) ; refusé s'il est déjà suivi ;
 *  - « existant » : un dossier déjà suivi est seulement inscrit (rien n'y est écrit) ; un dossier
 *    de code qui ne l'est pas reçoit l'outil, sans qu'aucun de ses fichiers soit remplacé.
 * Dans les deux cas où l'outil est posé, chantiers.json est construit tout de suite.
 */
export function inscrire(reg, { mode = "existant", dossier, nom, id } = {}) {
  const d = String(dossier || "").trim();
  if (!isAbsolute(d)) throw new Error(`chemin absolu attendu : « ${d} »`);
  const abs = resolve(d);
  const suivi = existsSync(join(abs, CONFIG_FILE));
  if (mode === "nouveau") {
    if (suivi) throw new Error(`${abs} est déjà suivi : choisir « Projet existant »`);
    if (!String(nom || "").trim()) throw new Error("nom du projet attendu");
  } else if (!existsSync(abs)) throw new Error(`${abs} n'existe pas`);
  if (suivi) return addProject(reg, abs, { id });
  // Id vérifié AVANT d'écrire quoi que ce soit dans le dossier.
  const pid = slugId(id || String(nom || "").trim() || basename(abs));
  if (!pid) throw new Error("id vide (choisir un nom)");
  if (reg.projets.some((p) => p.id === pid)) throw new Error(`id déjà pris : ${pid} (choisir un autre nom)`);
  mkdirSync(abs, { recursive: true });
  installInto(abs, { nom: String(nom || "").trim() || undefined, out: () => {} });
  const r = spawnSync(process.execPath, [join(abs, "scripts", "worklog", "chantiers-tracker.mjs"), "--root", abs], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`outil installé, mais npm run chantiers a échoué : ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
  return addProject(reg, abs, { id: pid });
}

function versionDe(dossier) {
  try { return readFileSync(join(dossier, "scripts", "worklog", "VERSION"), "utf8").trim() || null; } catch { return null; }
}

export function createAccueil({ registry = registryFile(), uiDir = join(SRC, "docs", "tracker"), outil, today = jourLocal }) {
  const files = new Map(); // id -> file d'écriture du projet

  function liste(res) {
    const reg = loadRegistry(registry);
    const projets = reg.projets.map((e) => {
      const o = ouvrir(e);
      const base = { id: e.id, type: e.type, dossier: e.dossier };
      if (o.erreur) return { ...base, nom: o.cfg ? o.cfg.projet : null, erreur: o.erreur };
      try {
        const r = summarize(lireJson(o.dataFile), { today: today(), version: versionDe(o.dossier), outil });
        // Nom et couleurs : le réglage du projet décide (chantiers.json peut dater d'avant un changement).
        Object.assign(r, { nom: o.cfg.projet || r.nom, accent: o.cfg.ui.accent || r.accent, accentSombre: o.cfg.ui.accentSombre || r.accentSombre });
        return { ...base, resume: r };
      }
      catch { return { ...base, erreur: "chantiers.json illisible" }; }
    });
    return send(res, 200, { ok: true, outil, projets });
  }

  function donnees(res, reg, o) {
    let data;
    try { data = lireJson(o.dataFile); } catch { return fail(res, 500, "chantiers.json illisible"); }
    const meta = (data.meta ||= {});
    meta.ui = { ...(meta.ui || {}), racine: "fichiers/", backlog: "fichiers/" + posix(relative(o.dossier, at(o.dossier, o.cfg, "backlog"))) };
    meta.accueil = {
      url: "/",
      projets: reg.projets.map((e) => {
        let nom = e.id;
        try { nom = loadConfig(resolve(e.dossier)).projet || e.id; } catch { /* dossier absent : l'id suffit */ }
        return { id: e.id, nom };
      }),
    };
    return send(res, 200, JSON.stringify(data));
  }

  async function ecrire(req, res, faire) {
    const refus = writeGuard(req);
    if (refus) return fail(res, refus.code, refus.error);
    let input;
    try { input = JSON.parse(await readBody(req)); } catch { return fail(res, 400, "charge invalide"); }
    if (!input || typeof input !== "object") return fail(res, 400, "charge invalide");
    return faire(input);
  }

  function projet(req, res, reg, id, rest) {
    const entree = reg.projets.find((p) => p.id === id);
    if (!entree) return fail(res, 404, "projet inconnu");
    if (rest === null) { res.writeHead(301, { Location: `/p/${id}/` }); return res.end(); }
    const o = ouvrir(entree);
    if (rest === "save.php") {
      if (req.method !== "POST") return fail(res, 405, "POST attendu");
      if (!o.dataFile) return fail(res, 404, o.erreur);
      return ecrire(req, res, (input) => {
        if (typeof input.patch !== "object" || input.patch === null) return fail(res, 400, "charge invalide (patch attendu)");
        const q = (files.get(id) || Promise.resolve()).then(() => {
          try { send(res, 200, { ok: true, ...savePatch(o.dataFile, input.patch) }); } catch (e) { fail(res, 500, e.message); }
        });
        files.set(id, q);
        return q;
      });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "lecture seule");
    if (rest === "" || UI.has(rest)) return serveFile(req, res, uiDir, rest || "index.html");
    if (!o.dossier) return fail(res, 404, o.erreur);
    if (rest === "chantiers.json") return o.dataFile ? donnees(res, reg, o) : fail(res, 404, o.erreur);
    if (rest === "code_stats.json") return serveFile(req, res, o.tracker, "code_stats.json");
    // Bac à sable : une page HTML d'un projet (node_modules, docs…) ne s'exécute pas avec les droits de l'accueil.
    if (rest.startsWith("fichiers/")) return serveFile(req, res, o.dossier, rest.slice("fichiers/".length), { "Content-Security-Policy": "sandbox" });
    return fail(res, 404, "introuvable");
  }

  async function route(req, res) {
    if (!isLocalHost(req)) return fail(res, 403, "hôte refusé : ouvrir http://localhost");
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch { return fail(res, 400, "adresse invalide"); }
    if (pathname === "/" || RACINE.has(pathname.slice(1))) {
      if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "lecture seule");
      return serveFile(req, res, uiDir, pathname === "/" ? "accueil.html" : pathname.slice(1));
    }
    let reg;
    try { reg = loadRegistry(registry); } catch (e) { return fail(res, 500, e.message); }
    if (pathname === "/api/projets") {
      if (req.method === "GET") return liste(res);
      if (req.method !== "POST") return fail(res, 405, "GET ou POST attendu");
      return ecrire(req, res, (input) => {
        try {
          const p = inscrire(reg, { mode: input.mode, dossier: input.dossier, nom: input.nom, id: input.id || undefined });
          saveRegistry(registry, reg);
          return send(res, 200, { ok: true, projet: p });
        } catch (e) { return fail(res, 400, e.message); }
      });
    }
    if (pathname === "/api/projets/retirer") {
      if (req.method !== "POST") return fail(res, 405, "POST attendu");
      return ecrire(req, res, (input) => {
        if (!removeProject(reg, String(input.id || ""))) return fail(res, 404, "projet inconnu");
        saveRegistry(registry, reg);
        return send(res, 200, { ok: true });
      });
    }
    const m = /^\/p\/([^/]+)(\/(.*))?$/.exec(pathname);
    if (m) return projet(req, res, reg, m[1], m[2] === undefined ? null : m[3]);
    return fail(res, 404, "introuvable");
  }

  return createServer((req, res) => { route(req, res).catch((e) => { if (!res.headersSent) fail(res, 500, e.message); }); });
}

function main(argv) {
  const opt = (name) => { const k = argv.indexOf(name); return k >= 0 ? argv[k + 1] : undefined; };
  const [cmd, arg] = argv.filter((a, k) => !a.startsWith("--") && !(k > 0 && argv[k - 1].startsWith("--")));
  const file = registryFile();
  if (cmd === "ajouter" || cmd === "retirer" || cmd === "liste") {
    const reg = loadRegistry(file);
    if (cmd === "liste") {
      if (!reg.projets.length) console.log(`Aucun projet inscrit (${file}).`);
      for (const p of reg.projets) console.log(`${p.id.padEnd(16)} ${p.type.padEnd(9)} ${p.dossier}`);
      return 0;
    }
    if (!arg) { console.error(`Usage : accueil.mjs ${cmd} ${cmd === "ajouter" ? "<dossier> [--id <id>]" : "<id>"}`); return 2; }
    if (cmd === "ajouter") {
      const p = addProject(reg, resolve(arg), { id: opt("--id") });
      saveRegistry(file, reg);
      console.log(`inscrit : ${p.id} (${p.dossier})`);
    } else {
      if (!removeProject(reg, arg)) { console.error(`projet inconnu : ${arg}`); return 1; }
      saveRegistry(file, reg);
      console.log(`retiré de l'accueil : ${arg} (aucun fichier du projet touché)`);
    }
    return 0;
  }
  const port = Number(opt("--port")) || PORT;
  const outil = lireJson(join(SRC, "package.json")).version;
  createAccueil({ registry: file, outil }).listen(port, "127.0.0.1", () => {
    console.log(`Accueil : http://localhost:${port}/  (registre : ${file})`);
    console.log("Ctrl+C pour arrêter.");
  });
  return null;
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try { const code = main(process.argv.slice(2)); if (code !== null) process.exitCode = code; }
  catch (e) { console.error(`ERREUR : ${e.message}`); process.exitCode = 1; }
}
