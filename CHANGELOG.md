# Nouveautés

Chaque version de l'outil, la plus récente en tête. Le numéro suit [SemVer](https://semver.org/lang/fr/) : un changement de second chiffre ajoute sans rien casser, un changement de premier chiffre demande d'adapter le projet (la section « À faire » le dit).

Mettre un projet à jour : `node scripts/worklog/install.mjs <dossier du projet>` depuis ce dépôt (voir le [README](README.md#mettre-à-jour)).

Le fichier ne décrit que ce qui est livré. Publier une version : ajouter en tête une section `## x.y.z · date` qui décrit ses changements, porter le numéro dans `package.json`, puis `git tag -a vx.y.z` et une release GitHub qui reprend la section.

## 1.4.0 · 2026-10-23

### Ajouté

- **Accueil multi-projets** : `npm run accueil` (dans ce dépôt) sert `http://localhost:4170/`, une carte par projet suivi : pourcentage de tâches faites, chantiers en cours, tâches à vérifier, décisions attendues, chantiers bloqués, tâches bougées dans les 7 derniers jours. La carte ouvre le tableau du projet à `/p/<id>/`, avec un lien « Mes projets » et une liste pour passer à un autre projet. Ajout d'un projet depuis la page ou par `accueil.mjs ajouter <dossier>` ; retrait de la carte (aucun fichier du projet touché).
- **Registre des projets** : `~/.agent-worklog/projets.json`, personnel, hors de tout dépôt. `install.mjs` y inscrit le projet qu'il installe.

### Modifié

- **Nouveau design** du tableau, en clair et en sombre : cartes à ombre douce, liseré à la couleur du projet, chiffres à chasse fixe, contrastes vérifiés dans les deux thèmes.
- **Téléphone** : indicateurs deux par ligne, filtres repliés derrière un bouton « Filtres », kanban une colonne à la fois avec un sélecteur.
- Les garde-fous HTTP du serveur sont dans `scripts/worklog/http.mjs`, partagé par `serve.mjs` et l'accueil.

### À faire dans un projet

Rien : relancer l'installation (elle inscrit aussi le projet à l'accueil).

## 1.3.0 · 2026-10-23

### Modifié

- **L'onglet « Tableau » est le kanban des tâches**, et plus celui des chantiers : colonnes À faire, En cours, À vérifier, Fait. Les chantiers fermés passaient le plus souvent en « clos » et n'apparaissaient jamais dans la colonne « Terminé » ; ils restent dans « Terminés & clos », les chantiers ouverts dans « Priorisation ». Glisser une carte dans une autre colonne change le statut de la tâche (au clavier : la liste Statut de la carte). Les filtres des tâches s'appliquent (chantier, lot, domaine, priorité, recherche). Chaque colonne montre 30 cartes, « Afficher les N autres » donne la suite ; « Fait » met les plus récentes en tête (date du suivi). Les tâches abandonnées restent dans l'onglet « Tâches ».

### À faire dans un projet

Rien : relancer l'installation.

## 1.2.0 · 2026-10-23

### Ajouté

- **Réglage `ui.marqueCasse`** : à `true`, seul le mot écrit dans la casse du réglage marque une tâche « décision attendue » (`DÉCISION`, et plus « la décision du 4 octobre » dans le texte d'une tâche). Les accents restent indifférents. Par défaut la casse ne compte pas, comme avant.

### À faire dans un projet

Rien : relancer l'installation. Un backlog qui écrit souvent « décision » en minuscules dans ses textes active `ui.marqueCasse`.

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
