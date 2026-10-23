// Verrou du dépôt public : refuse clés, jetons, mots de passe de connexion, IP réelles,
// chemins du poste, emails et mots de la liste personnelle (hors du dépôt).
// Sans dépendance : n'utilise que node:*.
//   node scripts/worklog/verrou.mjs            tout le dépôt (git ls-files)
//   node scripts/worklog/verrou.mjs --indexes  fichiers indexés (crochet pre-commit)
//   node scripts/worklog/verrou.mjs --push     lit les lignes de pre-push sur l'entrée
//   node scripts/worklog/verrou.mjs installer  écrit les crochets pre-commit et pre-push
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Une exception s'applique à la ligne entière, à ces fichiers seulement.
const EXCEPTIONS = [
  { chemin: "LICENSE", ligne: /^Copyright/ },
  { chemin: /^(README\.md|package\.json)$/, ligne: /github\.com\/[\w-]+\/agent-worklog/ },
];

const IP_ADMISES = [
  (o) => o[0] === 127,
  (o) => o.every((x) => x === 0),
  (o) => o.every((x) => x === 255),
  (o) => o[0] === 192 && o[1] === 0 && o[2] === 2,
  (o) => o[0] === 198 && o[1] === 51 && o[2] === 100,
  (o) => o[0] === 203 && o[1] === 0 && o[2] === 113,
];

// Masque le milieu : jamais la valeur entière d'un secret.
function masquer(s) {
  return s.length <= 6 ? "***" : `${s.slice(0, 2)}…${s.slice(-1)}`;
}

function exceptee(chemin, ligne) {
  const c = chemin.replaceAll("\\", "/");
  return EXCEPTIONS.some((e) => (typeof e.chemin === "string" ? e.chemin === c : e.chemin.test(c)) && e.ligne.test(ligne));
}

function motifsLigne(ligne, { sansEmail }) {
  const trouves = [];
  const ajouter = (motif, valeur) => trouves.push({ motif, extrait: masquer(valeur) });
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(ligne)) ajouter("cle-privee", "clé privée");
  for (const m of ligne.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) {
    const o = m.slice(1).map(Number);
    if (o.some((x) => x > 255) || IP_ADMISES.some((f) => f(o))) continue;
    ajouter("ip", m[0]);
  }
  for (const m of ligne.matchAll(/\w+:\/\/[^/\s:@]*:(?!\d+(?:\/|\s|$))([^@\s]+)@/g)) {
    if (/^<.*>$/.test(m[1]) || m[1] === "***") continue;
    ajouter("connexion", m[1]);
  }
  for (const m of ligne.matchAll(/[A-Za-z]:[\\/](?:Users|wamp64|apps)[\\/]|\/home\/[a-z]|\/Users\/[A-Za-z]/g)) ajouter("chemin-poste", m[0]);
  if (!sansEmail) {
    // Domaine à extension commençant par une lettre (pkg@3.24.6 n'est pas un email) ; seule l'adresse SCP git (git@hote:chemin) est admise.
    for (const m of ligne.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)*\.[A-Za-z][\w-]*)(?![\w-])/g)) {
      if (m[0].startsWith("git@") && /^:[\w~./-]/.test(ligne.slice(m.index + m[0].length))) continue;
      if (/^(example\.(com|org|net)|exemple\.fr)$/i.test(m[1]) || /^users\.noreply\.github\.com$/i.test(m[1])) continue;
      ajouter("email", m[0]);
    }
  }
  const jeton = /(?:Bearer\s+|jeton|token)[\s:="']*([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])|"\s*:\s*"([A-Za-z0-9_-]{43})"/gi;
  for (const m of ligne.matchAll(jeton)) ajouter("jeton", m[1] ?? m[2]);
  return trouves;
}

export function analyser(texte, { chemin, interdits = [], sansEmail = false } = {}) {
  const res = [];
  texte.split(/\r?\n/).forEach((ligne, i) => {
    if (exceptee(chemin ?? "", ligne)) return;
    for (const t of motifsLigne(ligne, { sansEmail })) res.push({ ligne: i + 1, ...t });
    const bas = ligne.toLowerCase();
    // Le mot lui-même n'est jamais écrit dans la sortie (un agent pourrait la recopier) : son rang dans la liste.
    interdits.forEach((mot, k) => {
      if (bas.includes(mot.toLowerCase())) res.push({ ligne: i + 1, motif: `interdit:#${k + 1}`, extrait: "***" });
    });
  });
  return res;
}

export function lireInterdits(maison) {
  const f = join(maison, "interdits.txt");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

export function verifierMessages(texte, { interdits = [] } = {}) {
  return analyser(texte, { chemin: "message", interdits, sansEmail: true });
}

function git(root, args, input) {
  const r = spawnSync("git", args, { cwd: root, input, maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

// Lecture d'un contenu qui doit exister : échec = refus (les suppressions sont écartées en amont).
function gitLire(root, args) {
  const buf = git(root, args);
  if (!buf) throw new Error(`git ${args[0]} a échoué`);
  return buf;
}

// Les listes (fichiers, commits) échouent bruyamment : le verrou ne s'ouvre jamais sur une erreur git.
function gitListe(root, args) {
  const buf = git(root, args);
  if (!buf) throw new Error(`git ${args[0]} a échoué`);
  return buf.toString("utf8").split(/\r?\n/).filter(Boolean);
}
const binaire = (buf) => buf.subarray(0, 8000).includes(0);

function verifierContenus(liste, lire, interdits) {
  const refus = [];
  for (const chemin of liste) {
    const buf = lire(chemin);
    if (!buf || binaire(buf)) continue;
    for (const r of analyser(buf.toString("utf8"), { chemin, interdits })) refus.push({ chemin, ...r });
  }
  return refus;
}

export function verifierDepot(root, { interdits = [], fichiers } = {}) {
  const liste = fichiers ?? gitListe(root, ["ls-files"]);
  const lire = (c) => (existsSync(join(root, c)) ? readFileSync(join(root, c)) : null);
  return verifierContenus(liste, lire, interdits);
}

function verifierIndexes(root, interdits) {
  const liste = gitListe(root, ["diff", "--cached", "--name-only", "--diff-filter=d"]);
  return verifierContenus(liste, (c) => gitLire(root, ["show", `:${c}`]), interdits);
}

function verifierPush(root, entree, interdits) {
  const refus = [];
  for (const l of entree.split(/\r?\n/).filter(Boolean)) {
    const [, local, , distant] = l.split(" ");
    if (/^0+$/.test(local)) continue; // suppression de branche
    const nouveau = /^0+$/.test(distant);
    const plage = nouveau ? [local, "--not", "--remotes"] : [`${distant}..${local}`];
    // Chaque commit envoyé est lu tel qu'il est entré dans l'historique (un secret retiré plus tard y reste).
    for (const c of gitListe(root, ["rev-list", ...plage])) {
      const fichiers = [...new Set(gitListe(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "--root", "--diff-filter=d", c]))];
      refus.push(...verifierContenus(fichiers, (f) => gitLire(root, ["show", `${c}:${f}`]), interdits).map((r) => ({ ...r, chemin: `${r.chemin} (commit ${c.slice(0, 7)})` })));
      const msg = git(root, ["show", "-s", "--format=%B", c]);
      if (!msg) throw new Error("git show a échoué");
      for (const r of verifierMessages(msg.toString("utf8"), { interdits })) refus.push({ chemin: `commit ${c.slice(0, 7)}`, ...r });
    }
  }
  return refus;
}

function installer(root) {
  const gitDir = git(root, ["rev-parse", "--git-path", "hooks"])?.toString("utf8").trim();
  if (!gitDir) throw new Error("pas un dépôt git");
  const dossier = resolve(root, gitDir);
  mkdirSync(dossier, { recursive: true });
  const crochets = [["pre-commit", "--indexes"], ["pre-push", "--push"]];
  // Un crochet qui n'est pas le nôtre est gardé : refus net, rien n'est écrit.
  for (const [nom] of crochets) {
    const f = join(dossier, nom);
    if (existsSync(f) && !readFileSync(f, "utf8").includes("scripts/worklog/verrou.mjs")) {
      throw new Error(`un crochet ${nom} existe déjà et n'est pas celui du verrou (${f}) ; l'intégrer à la main ou le retirer`);
    }
  }
  for (const [nom, arg] of crochets) {
    const f = join(dossier, nom);
    writeFileSync(f, `#!/bin/sh\nexec node scripts/worklog/verrou.mjs ${arg}\n`);
    chmodSync(f, 0o755);
  }
  return dossier;
}

function lireEntree() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

function main(argv) {
  let root;
  try {
    root = gitListe(process.cwd(), ["rev-parse", "--show-toplevel"])[0];
    if (argv[0] === "installer") {
      console.log(`verrou : crochets installés dans ${installer(root)}`);
      return 0;
    }
  } catch (e) {
    console.error(`verrou : ${argv[0] === "installer" ? "installation impossible" : "vérification impossible, refusé"} (${e.message}).`);
    return 1;
  }
  const interdits = lireInterdits(process.env.AGENT_WORKLOG_HOME || join(homedir(), ".agent-worklog"));
  let refus;
  try {
    refus = argv[0] === "--indexes" ? verifierIndexes(root, interdits)
      : argv[0] === "--push" ? verifierPush(root, lireEntree(), interdits)
      : verifierDepot(root, { interdits });
  } catch (e) {
    console.error(`verrou : vérification impossible, refusé (${e.message}).`);
    return 1;
  }
  if (!refus.length) return 0;
  console.error("verrou : refusé, dépôt public.");
  for (const r of refus) console.error(`  ${r.chemin}:${r.ligne} ${r.motif} (${r.extrait})`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
