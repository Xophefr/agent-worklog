// Régénère integrations/codex/AGENTS.md depuis le skill Claude Code, la seule source de la
// procédure : même texte, sans l'en-tête du skill, titres décalés d'un niveau pour s'insérer
// dans un AGENTS.md existant.
//
//   npm run agents:sync
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SKILL = join(ROOT, "integrations", "claude-code", "skills", "chantiers", "SKILL.md");
export const AGENTS = join(ROOT, "integrations", "codex", "AGENTS.md");

export function agentsFromSkill(skill) {
  const body = skill.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n+/, "");
  return body.split(/\r?\n/).map((l) => {
    if (l.startsWith("# ")) return "## Suivi des chantiers (à faire à chaque session)\n\nÀ suivre au DÉBUT de toute session de travail, à CHAQUE étape livrée et à la FIN.";
    return l.startsWith("## ") ? "#" + l : l;
  }).join("\n");
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  writeFileSync(AGENTS, agentsFromSkill(readFileSync(SKILL, "utf8")), "utf8");
  console.log("écrit integrations/codex/AGENTS.md");
}
