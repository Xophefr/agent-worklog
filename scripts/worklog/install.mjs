// Installe (ou met à jour) le suivi des chantiers dans un autre projet.
//
//   node scripts/worklog/install.mjs ../mon-projet
//
// Copie les fichiers de l'OUTIL (tableau et scripts), toujours remplacés : relancer la commande
// met à jour. Ne remplace JAMAIS ce qui appartient au projet : tracker.config.json, CHANTIERS.md,
// backlog, specs, chantiers.json. Ajoute les commandes npm manquantes au package.json du projet
// (le crée s'il n'existe pas), sans toucher à celles qui existent.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { at, CONFIG_FILE, loadConfig } from "./config.mjs";
import { addProject, loadRegistry, registryFile, saveRegistry } from "./registre.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "..");
const UI_FILES = ["index.html", "app.js", "xlsx.js", "style.css", "save.php", ".gitignore"];
// Restent dans ce dépôt : l'installation, l'accueil multi-projets, le BFF (et ses pilotes de base,
// dans base/, jamais copié) et ce qui ne sert qu'à eux. Un projet suivi n'a aucune dépendance.
const OUTIL_SEUL = ["install.mjs", "sync-agents.mjs", "VERSION", "accueil.mjs", "registre.mjs", "resume.mjs", "bff.mjs", "operations.mjs", "export-md.mjs"];
const SCRIPTS = { chantiers: "node scripts/worklog/chantiers-tracker.mjs", tracker: "node scripts/worklog/serve.mjs", "code:stats": "node scripts/worklog/code-stats.mjs" };

/**
 * Installe (ou met à jour) l'outil dans `dest`, qui existe. `nom` : nom du projet d'un réglage
 * neuf (sinon le nom du dossier). `out` reçoit chaque ligne du compte rendu. Lève une Error.
 */
export function installInto(dest, { nom, out = console.log } = {}) {
  if (resolve(dest) === SRC) throw new Error("le projet cible est ce dépôt lui-même");
  const log = (verbe, p) => out(`  ${verbe.padEnd(9)} ${relative(dest, p).replaceAll("\\", "/")}`);

  // 1. Réglage : celui du projet s'il existe, sinon un neuf au nom du dossier.
  const cfgPath = join(dest, CONFIG_FILE);
  if (!existsSync(cfgPath)) {
    const modele = JSON.parse(readFileSync(join(SRC, CONFIG_FILE), "utf8"));
    modele.projet = nom || basename(dest);
    delete modele.code.compterOutil; // ce dépôt-ci mesure l'outil ; un projet mesure son propre code
    writeFileSync(cfgPath, JSON.stringify(modele, null, 4) + "\n", "utf8");
    log("créé", cfgPath);
  } else log("gardé", cfgPath);
  const cfg = loadConfig(dest);

  // 2. Outil : tableau et scripts, remplacés à chaque passage.
  const ui = at(dest, cfg, "tracker");
  mkdirSync(ui, { recursive: true });
  for (const f of UI_FILES) { copyFileSync(join(SRC, "docs", "tracker", f), join(ui, f)); log("copié", join(ui, f)); }
  const sd = join(dest, "scripts", "worklog");
  mkdirSync(sd, { recursive: true });
  for (const f of readdirSync(HERE, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.includes(".test.") && !OUTIL_SEUL.includes(e.name)).map((e) => e.name)) { copyFileSync(join(HERE, f), join(sd, f)); log("copié", join(sd, f)); }
  // La version installée reste dans le projet : on sait d'où l'on part à la mise à jour suivante.
  const version = JSON.parse(readFileSync(join(SRC, "package.json"), "utf8")).version;
  const vFile = join(sd, "VERSION");
  const avant = existsSync(vFile) ? readFileSync(vFile, "utf8").trim() : null;
  writeFileSync(vFile, version + "\n", "utf8");
  out(`  agent-worklog ${avant && avant !== version ? `${avant} -> ${version} (voir CHANGELOG.md)` : version}`);

  // 3. Docs du projet : modèles posés seulement dans un projet NEUF (ni registre ni backlog). Un
  // projet qui a déjà ses docs règle d'abord leurs chemins dans tracker.config.json : sans cela,
  // un backlog modèle apparaissait à l'adresse par défaut, à côté du vrai.
  const modeles = [
    [join(SRC, "docs", "CHANTIERS.md"), at(dest, cfg, "chantiers")],
    [join(SRC, "docs", "chantiers", "backlog.md"), at(dest, cfg, "backlog")],
    [join(SRC, "docs", "chantiers", "CH-01_exemple.md"), join(at(dest, cfg, "specs"), "CH-01_exemple.md")],
  ];
  const neufs = !existsSync(modeles[0][1]) && !existsSync(modeles[1][1]);
  for (const [from, to] of modeles) {
    if (existsSync(to)) { log("gardé", to); continue; }
    if (!neufs) { log("absent", to); continue; }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    log("créé", to);
  }

  // 4. Commandes npm.
  const pkgPath = join(dest, "package.json");
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : { name: basename(dest).toLowerCase().replace(/[^a-z0-9-]+/g, "-"), private: true };
  pkg.scripts ||= {};
  const ajoutes = [];
  for (const [k, v] of Object.entries(SCRIPTS)) if (!pkg.scripts[k]) { pkg.scripts[k] = v; ajoutes.push(k); }
  const conflit = Object.keys(SCRIPTS).filter((k) => pkg.scripts[k] !== SCRIPTS[k]);
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  log(ajoutes.length ? "complété" : "gardé", pkgPath);
  if (conflit.length) out(`  ATTENTION : commande(s) npm déjà prises par le projet : ${conflit.join(", ")} ; lancer alors ${conflit.map((k) => SCRIPTS[k]).join(" / ")}`);

  return { cfg, ui };
}

function main() {
  const arg = process.argv[2];
  if (!arg || arg.startsWith("--")) { console.error("Usage : node scripts/worklog/install.mjs <dossier du projet>"); return 2; }
  const dest = resolve(arg);
  if (!existsSync(dest)) { console.error(`ERREUR : ${dest} n'existe pas`); return 2; }
  let cfg, ui;
  try { ({ cfg, ui } = installInto(dest)); } catch (e) { console.error(`ERREUR : ${e.message}`); return 2; }

  // 5. Accueil multi-projets : le projet y est inscrit (une seule fois). Un refus (id déjà pris…)
  // n'empêche pas l'installation : il se règle avec `accueil.mjs ajouter <dossier> --id <id>`.
  try {
    const file = registryFile();
    const reg = loadRegistry(file);
    const n = reg.projets.length;
    const p = addProject(reg, dest);
    if (reg.projets.length > n) { saveRegistry(file, reg); console.log(`  inscrit   accueil : ${p.id}`); }
    else console.log(`  gardé     accueil : ${p.id}`);
  } catch (e) { console.log(`  ATTENTION : non inscrit à l'accueil (${e.message})`); }

  console.log(`\nSuite, dans ${dest} :\n  npm run chantiers      # construit ${relative(dest, join(ui, "chantiers.json")).replaceAll("\\", "/")}\n  npm run tracker        # ouvre le tableau sur http://localhost:${cfg.serveur.port}/\n  npm run code:stats     # premier relevé de l'onglet « Code » (régler code.groupes dans ${CONFIG_FILE})\n\nTous les projets inscrits, depuis ce dépôt :\n  npm run accueil        # http://localhost:4170/`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) process.exitCode = main();
