# Nouveautés

Chaque version de l'outil, la plus récente en tête. Le numéro suit [SemVer](https://semver.org/lang/fr/) : un changement de second chiffre ajoute sans rien casser, un changement de premier chiffre demande d'adapter le projet (la section « À faire » le dit).

Mettre un projet à jour : `node scripts/worklog/install.mjs <dossier du projet>` depuis ce dépôt (voir le [README](README.md#mettre-à-jour)).

## 1.1.0 · 2026-10-23

### Ajouté

- **Export Excel** : bouton de téléchargement en haut du tableau. Un classeur `.xlsx` à deux feuilles, « Chantiers » et « Tâches », avec en-tête figé et filtre automatique ; tout le registre, quels que soient les filtres affichés. Écrit dans le navigateur, sans dépendance (`docs/tracker/xlsx.js`).
- **Deux écritures de tâche de plus dans le backlog**, pour un backlog déjà rédigé autrement : en titre (`### API-03 : limite de débit \`P2\``) et en paragraphe (`**API-04** \`P1\` : texte`).
- **Ids à chiffres** : `I18N-04` est un id valide (préfixe de 2 à 4 majuscules et chiffres, commençant par une lettre).
- **Réglage `rattachements`** : chantier par défaut des tâches d'un backlog qui n'est pas rangé en sections `## CH-xx`.
- **Réglage `controle.enCoursSpecSeulement`** : « en cours sans tâche qui bouge » n'est signalé que pour un chantier dont la doc est une spec, pour un projet dont certains chantiers sont plus anciens que le suivi.
- **Réglage `ui.echelle`** : taille du texte du tableau, en % (125 par défaut).

### Modifié

- La lecture du backlog s'arrête à la première section `## Annexe…` : une annexe cite des tâches, elle n'en déclare pas.
- Le constat d'une tâche garde la cellule entière ; seul le titre est coupé à 160 caractères.
- La section d'une tâche se lit sans numéro ni code de domaine (`### 4.2 Recherche \`RCH\`` → « Recherche »).
- Titres de lot : plus d'espace orphelin avant une virgule une fois les parenthèses retirées.
- L'installation ne pose plus aucun modèle (registre, backlog, spec d'exemple) dans un projet qui a déjà ses docs.

### À faire dans un projet

Rien : relancer l'installation suffit. Un projet qui garde ses docs ailleurs qu'aux chemins par défaut les règle dans `tracker.config.json` avant d'installer.

## 1.0.0 · 2026-10-17

Première version : registre `docs/CHANTIERS.md`, backlog, specs découpées en lots, tableau local à cinq vues, script des sessions (`--statut`, `--suivi`, `--chantier`, `--lot`, `--strict`), relevé du code, instructions pour Claude Code et Codex.
