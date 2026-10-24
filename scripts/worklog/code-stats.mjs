// Compte les lignes de code du projet et ajoute un relevé daté à <tracker>/code_stats.json,
// que lit l'onglet « Code » du tableau de suivi.
//
//   npm run code:stats                    # compte, ajoute le relevé du jour, écrit
//   npm run code:stats -- --check         # affiche seulement
//
// Les groupes (code source, scripts, tests…) se règlent dans tracker.config.json, clé `code` :
//   { "cle": "api", "libelle": "API", "production": true, "racines": ["api/src"],
//     "suffixes": [".ts"], "tests": "exclure" | "seulement" | "tous", "cas": true }
// `production: false` range le groupe sous « Total tests ». `cas: true` compte aussi les cas
// de test déclarés (it/test en JS et TS, def test_ en Python, func Test en Go, function test
// en PHP) : un plancher, la paramétrisation en produit davantage à l'exécution.
//
// Un relevé par jour : rejouer le même jour remplace le relevé du jour. C'est l'historique
// qui rend le chiffre utile ; le relevé automatique s'installe avec
// scripts/worklog/install-code-stats-task.ps1 (Windows) ou une ligne cron (voir README).
//
// Deux mesures par groupe : `brut` (toutes les lignes) et `net` (lignes non vides). Les
// commentaires comptent dans les deux : c'est un ordre de grandeur et une tendance.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { at, CONFIG_FILE, estLance, findRoot, loadConfig } from "./config.mjs";

const posix = (p) => p.replaceAll("\\", "/");

/** Un fichier de test : par son nom (x.test.ts, x.spec.js, test_x.py, x_test.go…) ou son dossier. */
export function isTest(p) {
  const s = posix(p);
  const name = s.split("/").pop();
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(name)
    || /^test_.*\.py$/.test(name) || /_test\.(py|go)$/.test(name) || /Test\.php$/.test(name)
    || /(^|\/)(tests?|__tests__|e2e)\//.test(s);
}

// Cas de test comptés sur les déclarations : un plancher stable.
const CAS = [
  { ext: /\.[cm]?[jt]sx?$/, re: /\b(?:it|test)\s*(?:\.\s*(?:only|skip|todo|concurrent|each|fails))?\s*\(/g },
  { ext: /\.py$/, re: /^\s*(?:async\s+)?def\s+test_\w*\s*\(/gm },
  { ext: /\.go$/, re: /^func\s+Test\w*\s*\(/gm },
  { ext: /\.php$/, re: /function\s+test\w*\s*\(|@test\b|\bit\s*\(|\btest\s*\(/g },
];
export function countCases(path, text) {
  const k = CAS.find((c) => c.ext.test(path));
  return k ? (text.match(k.re) || []).length : 0;
}

function walk(dir, exclus, out) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (exclus.has(name)) continue;
    const p = join(dir, name);
    if (exclus.has(resolve(p))) continue; // dossier exclu par son chemin (l'outil lui-même)
    if (statSync(p).isDirectory()) walk(p, exclus, out);
    else out.push(p);
  }
  return out;
}

export function mesureGroupe(root, g, exclus = new Set()) {
  const filtre = g.tests === "seulement" ? (p) => isTest(relative(root, p)) : g.tests === "tous" ? () => true : (p) => !isTest(relative(root, p));
  const files = [...new Set((g.racines || []).flatMap((r) => walk(join(root, ...r.split("/")), exclus, [])))]
    .filter((p) => (g.suffixes || []).some((s) => p.endsWith(s)) && filtre(p));
  let brut = 0, net = 0, cas = 0;
  for (const p of files) {
    const text = readFileSync(p, "utf8");
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    brut += lines.length;
    net += lines.filter((l) => l.trim()).length;
    if (g.cas) cas += countCases(p, text);
  }
  return g.cas ? { brut, net, fichiers: files.length, cas } : { brut, net, fichiers: files.length };
}

function main() {
  const root = findRoot();
  const cfg = loadConfig(root);
  const check = process.argv.includes("--check");
  const groupes = cfg.code.groupes || [];
  if (!groupes.length) { console.error(`ERREUR : aucun groupe dans ${CONFIG_FILE} (clé code.groupes)`); return 2; }
  const exclus = new Set(cfg.code.exclus || []);
  // L'outil installé dans le projet n'est pas le code du projet : hors relevé, sauf réglage contraire.
  if (!cfg.code.compterOutil) exclus.add(resolve(dirname(fileURLToPath(import.meta.url))));
  const mesures = Object.fromEntries(groupes.map((g) => [g.cle, mesureGroupe(root, g, exclus)]));
  for (const g of groupes) {
    const m = mesures[g.cle];
    console.log(`  ${g.libelle.padEnd(24)} ${String(m.brut).padStart(7)} lignes  ${String(m.net).padStart(7)} non vides  ${String(m.fichiers).padStart(4)} fichiers${m.cas !== undefined ? `  ${String(m.cas).padStart(5)} cas de test` : ""}`);
  }
  const total = groupes.filter((g) => g.production).reduce((s, g) => s + mesures[g.cle].brut, 0);
  console.log(`  ${"TOTAL production".padEnd(24)} ${String(total).padStart(7)} lignes`);
  if (check) return 0;

  const out = join(at(root, cfg, "tracker"), "code_stats.json");
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const quand = `${date}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const data = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
  data.meta = { genere_le: quand };
  data.groupes = groupes.map(({ cle, libelle, production }) => ({ cle, libelle, production: !!production }));
  data.releves = [...(data.releves || []).filter((r) => r.date !== date), { date, genere_le: quand, mesures }]
    .sort((a, b) => a.date.localeCompare(b.date));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(data, null, 4) + "\n", "utf8");
  console.log(`écrit ${posix(relative(root, out))} (${data.releves.length} relevé(s))`);
  // Mode base : le BFF ne voit pas le dépôt, le relevé lui est envoyé (onglet « Code »).
  if (cfg.mode === "base") {
    return import("./client.mjs").then((m) => m.envoyerCode(root, cfg, data)).then(() => { console.log(`envoyé au BFF (${cfg.bff})`); return 0; },
      (e) => { console.error(`ERREUR : relevé non envoyé au BFF : ${e.message}`); return 1; });
  }
  return 0;
}

if (estLance(import.meta.url)) Promise.resolve(main()).then((c) => { process.exitCode = c; });
