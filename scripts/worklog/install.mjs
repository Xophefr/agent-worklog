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

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "..");
const UI_FILES = ["index.html", "app.js", "xlsx.js", "style.css", "save.php", ".gitignore"];
const SCRIPTS = { chantiers: "node scripts/worklog/chantiers-tracker.mjs", tracker: "node scripts/worklog/serve.mjs", "code:stats": "node scripts/worklog/code-stats.mjs" };

function main() {
  const arg = process.argv[2];
  if (!arg || arg.startsWith("--")) { console.error("Usage : node scripts/worklog/install.mjs <dossier du projet>"); return 2; }
  const dest = resolve(arg);
  if (!existsSync(dest)) { console.error(`ERREUR : ${dest} n'existe pas`); return 2; }
  if (dest === SRC) { console.error("ERREUR : le projet cible est ce dépôt lui-même"); return 2; }
  const log = (verbe, p) => console.log(`  ${verbe.padEnd(9)} ${relative(dest, p).replaceAll("\\", "/")}`);

  // 1. Réglage : celui du projet s'il existe, sinon un neuf au nom du dossier.
  const cfgPath = join(dest, CONFIG_FILE);
  if (!existsSync(cfgPath)) {
    const modele = JSON.parse(readFileSync(join(SRC, CONFIG_FILE), "utf8"));
    modele.projet = basename(dest);
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
  for (const f of readdirSync(HERE).filter((n) => !n.includes(".test.") && !["install.mjs", "sync-agents.mjs"].includes(n))) { copyFileSync(join(HERE, f), join(sd, f)); log("copié", join(sd, f)); }

  // 3. Docs du projet : modèles posés seulement s'ils manquent.
  const modeles = [
    [join(SRC, "docs", "CHANTIERS.md"), at(dest, cfg, "chantiers")],
    [join(SRC, "docs", "chantiers", "backlog.md"), at(dest, cfg, "backlog")],
    [join(SRC, "docs", "chantiers", "CH-01_exemple.md"), join(at(dest, cfg, "specs"), "CH-01_exemple.md")],
  ];
  const neufs = !existsSync(modeles[0][1]) && !existsSync(modeles[1][1]);
  for (const [from, to] of modeles) {
    if (existsSync(to) || (!neufs && to.endsWith("CH-01_exemple.md"))) { log("gardé", to); continue; }
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
  if (conflit.length) console.log(`  ATTENTION : commande(s) npm déjà prises par le projet : ${conflit.join(", ")} ; lancer alors ${conflit.map((k) => SCRIPTS[k]).join(" / ")}`);

  console.log(`\nSuite, dans ${dest} :\n  npm run chantiers      # construit ${relative(dest, join(ui, "chantiers.json")).replaceAll("\\", "/")}\n  npm run tracker        # ouvre le tableau sur http://localhost:${cfg.serveur.port}/\n  npm run code:stats     # premier relevé de l'onglet « Code » (régler code.groupes dans ${CONFIG_FILE})`);
  return 0;
}

process.exitCode = main();
