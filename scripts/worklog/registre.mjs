// Registre des projets de l'accueil : ~/.agent-worklog/projets.json, personnel, hors de tout dépôt.
//
// Une entrée par projet : { id, type, dossier }. L'id sert dans l'adresse (/p/<id>/) et ne change
// plus une fois inscrit. Le nom affiché, la couleur et les chemins viennent du tracker.config.json
// du projet. `type` vaut "fichiers" (le suivi vit dans les .md du dépôt).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CONFIG_FILE, loadConfig } from "./config.mjs";

/** Fichier du registre ; AGENT_WORKLOG_HOME le déplace (tests, installation à part). */
export function registryFile(env = process.env) {
  return join(env.AGENT_WORKLOG_HOME || join(homedir(), ".agent-worklog"), "projets.json");
}

export function loadRegistry(file) {
  if (!existsSync(file)) return { projets: [] };
  const txt = readFileSync(file, "utf8");
  if (!txt.trim()) return { projets: [] }; // fichier créé vide (touch, éditeur) : aucun projet
  let reg;
  try { reg = JSON.parse(txt); } catch (e) { throw new Error(`projets.json illisible : ${e.message}`); }
  if (!reg || !Array.isArray(reg.projets)) throw new Error("projets.json illisible : liste « projets » attendue");
  return reg;
}

export function saveRegistry(file, reg) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(reg, null, 2) + "\n", "utf8");
}

/** « Réplycite Pro » -> « replycite-pro ». */
export function slugId(nom) {
  return String(nom).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Même dossier, quelle que soit l'écriture : antislashs, slash final, casse sous Windows.
const cle = (d) => { const p = resolve(d).replaceAll("\\", "/").replace(/\/+$/, ""); return process.platform === "win32" ? p.toLowerCase() : p; };

/** Inscrit `dossier` ; renvoie l'entrée (l'existante si le dossier est déjà inscrit). */
export function addProject(reg, dossier, { id } = {}) {
  // Absolu seulement : un chemin vide ou relatif se résoudrait contre le dossier du serveur.
  if (!isAbsolute(String(dossier).trim())) throw new Error(`chemin absolu attendu : « ${String(dossier).trim()} »`);
  const abs = resolve(String(dossier).trim());
  const deja = reg.projets.find((p) => cle(p.dossier) === cle(abs));
  if (deja) return deja;
  if (!existsSync(join(abs, CONFIG_FILE))) throw new Error(`pas de ${CONFIG_FILE} dans ${abs}`);
  const pid = slugId(id || loadConfig(abs).projet);
  if (!pid) throw new Error(`id vide pour ${abs} (choisir avec --id)`);
  if (reg.projets.some((p) => p.id === pid)) throw new Error(`id déjà pris : ${pid} (choisir avec --id)`);
  const entree = { id: pid, type: "fichiers", dossier: abs.replaceAll("\\", "/") };
  reg.projets.push(entree);
  return entree;
}

export function removeProject(reg, id) {
  const k = reg.projets.findIndex((p) => p.id === id);
  if (k < 0) return false;
  reg.projets.splice(k, 1);
  return true;
}
