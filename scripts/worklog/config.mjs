// Réglage commun aux scripts : lit tracker.config.json à la racine du projet.
//
// La racine est le premier dossier, en partant du dossier courant et en remontant, qui
// contient tracker.config.json ; `--root <dossier>` la force. Toute clé absente du
// fichier prend la valeur par défaut ci-dessous : un réglage vide suffit pour démarrer.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_FILE = "tracker.config.json";

export const DEFAULTS = {
  projet: "",
  // "fichiers" : le suivi vit dans les .md du dépôt ; "base" : dans la base du BFF (`bff`, `projetBase`).
  mode: "fichiers",
  bff: "",
  projetBase: "",
  chantiers: "docs/CHANTIERS.md",
  backlog: "docs/chantiers/backlog.md",
  specs: "docs/chantiers",
  tracker: "docs/tracker",
  ui: { accent: "#3538cd", accentSombre: "#a4a6ff", marque: "DÉCISION", marqueFiltre: "Décision attendue", marqueKpi: "décisions attendues" },
  serveur: { port: 4173 },
  code: { exclus: ["node_modules", "dist", "build", ".git", "coverage", "vendor", "__pycache__", ".venv", "venv"], groupes: [] },
};

/** Le dossier du projet : `--root`, sinon le premier parent qui porte tracker.config.json. */
export function findRoot(argv = process.argv.slice(2), from = process.cwd()) {
  const k = argv.indexOf("--root");
  if (k >= 0 && argv[k + 1]) return resolve(argv[k + 1]);
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(from);
    dir = up;
  }
}

export function loadConfig(root) {
  const p = join(root, CONFIG_FILE);
  let raw = {};
  if (existsSync(p)) {
    try { raw = JSON.parse(readFileSync(p, "utf8")); } catch (e) { throw new Error(`${CONFIG_FILE} illisible : ${e.message}`); }
  }
  return {
    ...DEFAULTS,
    ...raw,
    projet: raw.projet || basename(root),
    ui: { ...DEFAULTS.ui, ...(raw.ui || {}) },
    serveur: { ...DEFAULTS.serveur, ...(raw.serveur || {}) },
    code: { ...DEFAULTS.code, ...(raw.code || {}) },
  };
}

/** Chemin absolu d'une clé de réglage (`chantiers`, `backlog`, `specs`, `tracker`). */
export const at = (root, cfg, key) => join(root, ...String(cfg[key]).split("/"));

/**
 * Vrai si le script qui appelle (`import.meta.url`) est celui que Node a lancé. Les chemins sont
 * comparés une fois les liens symboliques résolus : Node donne à import.meta.url le chemin réel,
 * alors que process.argv[1] garde celui du lien (ex. `current -> releases/x`).
 */
export function estLance(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const reel = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return reel(argv1).toLowerCase() === reel(fileURLToPath(importMetaUrl)).toLowerCase();
}
