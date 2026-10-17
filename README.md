# agent-worklog

**Suivi des chantiers d'un projet logiciel, tenu à jour par les agents de code et lu sur un tableau local.**

Les agents de code (Claude Code, Codex, Cursor…) avancent vite, et l'état du projet se perd entre deux sessions : ce qui est fait, ce qui est seulement livré, ce qui attend une décision. agent-worklog donne au projet un registre unique, en Markdown, versionné avec le code. Les agents l'écrivent à chaque étape ; le responsable du projet le lit sur un tableau qui se met à jour seul mais sur lequel il peut intervenir.

- **Trois fichiers Markdown** dans le dépôt : l'état des chantiers, le backlog des tâches, une spec par chantier.
- **Un tableau local** à cinq vues (priorisation, kanban, tâches, terminés, code), sans dépendance, accessible au clavier, utilisable sur téléphone.
- **Un script** que l'agent appelle pour passer une tâche en cours, livrée ou faite, avec une phrase de suivi datée.
- **Un relevé des lignes de code et de tests**, jour après jour.
- **Des instructions prêtes à copier** pour Claude Code, Codex et les autres agents.

Aucune dépendance npm. Node.js 20 ou plus ; PHP en option.

### Au quotidien

Vous suivez l'avancement d'un coup d'œil sur le tableau : chantiers par priorité, tâches en cours, livrées ou faites, décisions qui vous attendent, et l'évolution du code. Chaque tâche porte la dernière phrase de suivi de l'agent : ce qui vient d'être fait et ce qui reste.

Comme tout le contexte d'un chantier est écrit dans le dépôt (son état, ses tâches, sa spec, son journal), une consigne courte suffit pour lancer le travail :

```text
Traite le chantier CH-04
```

L'agent lit la ligne du chantier, sa spec et ses tâches ouvertes, ouvre une ligne de journal, avance lot par lot en tenant le tableau à jour, puis ferme la session avec ce qui reste. La session suivante, la même consigne reprend là où il s'est arrêté, quel que soit l'agent.

---

## Sommaire

- [Au quotidien](#au-quotidien)
- [Démarrage rapide](#démarrage-rapide)
- [Installer dans un projet](#installer-dans-un-projet)
- [Fonctionnement](#fonctionnement)
- [Brancher un agent de code](#brancher-un-agent-de-code)
- [Commandes](#commandes)
- [Le tableau](#le-tableau)
- [Relevé du code](#relevé-du-code)
- [Réglage](#réglage)
- [Sécurité](#sécurité)
- [Structure du dépôt](#structure-du-dépôt)
- [Licence](#licence)

---

## Démarrage rapide

```bash
git clone https://github.com/Xophefr/agent-worklog.git
cd agent-worklog
npm run chantiers      # construit docs/tracker/chantiers.json depuis les modèles
npm run code:stats     # premier relevé de l'onglet « Code »
npm run tracker        # sert le tableau sur http://localhost:4173/
```

Le dépôt contient un chantier d'exemple (`CH-01`) qui montre chaque format. Ouvrez le tableau, changez le statut d'une tâche, puis relancez `npm run chantiers` : la modification est conservée.

## Installer dans un projet

```bash
node scripts/worklog/install.mjs ../mon-projet
```

La commande copie dans le projet :

| Copié | Où | Relancer la commande |
|---|---|---|
| Le tableau | `docs/tracker/` | le met à jour |
| Les scripts | `scripts/worklog/` | les met à jour |
| Le réglage | `tracker.config.json` | ne le touche pas |
| Les modèles | `docs/CHANTIERS.md`, `docs/chantiers/backlog.md`, spec d'exemple | ne les touche pas |
| Les commandes npm | `package.json` (créé s'il manque) | n'écrase aucune commande existante |

Relancer l'installation met donc l'outil à jour sans toucher aux données du projet. Il reste ensuite à [brancher l'agent de code](#brancher-un-agent-de-code) et à décrire les groupes du [relevé du code](#relevé-du-code).

À commiter dans le projet : les trois fichiers Markdown, les specs **et** `docs/tracker/chantiers.json`, qui porte les statuts, les priorités et les notes. `code_stats.json` reste local (déjà dans `docs/tracker/.gitignore`).

---

## Fonctionnement

```
  docs/CHANTIERS.md ────────┐                         ┌──── le tableau (navigateur)
  état de chaque chantier   │                         │     priorités, rangs, notes,
  + journal                 │   npm run chantiers     │     statuts des tâches
                            ├──────────────────────▶ docs/tracker/chantiers.json
  docs/chantiers/backlog.md │   (+ --statut/--suivi   │
  tâches par chantier       │    d'une session)       │
                            │                         │
  docs/chantiers/CH-xx_*.md ┘                         └──── npm run tracker (ou PHP)
  détail, découpage en lots
```

### Qui écrit quoi

| Fichier | Porte | Écrit par |
|---|---|---|
| `docs/CHANTIERS.md` | l'ÉTAT de chaque chantier (une ligne) et le journal (ajout seul) | l'agent ou l'humain, à la main |
| `docs/chantiers/backlog.md` | les TÂCHES : id, priorité, titre, attendu | l'agent ou l'humain, à la main |
| `docs/chantiers/CH-xx_*.md` | le DÉTAIL d'un chantier : décisions, mesures, lots, reprise | l'agent ou l'humain, à la main |
| `docs/tracker/chantiers.json` | statut et suivi des tâches, priorité, rang et notes | `npm run chantiers` et le tableau, **jamais à la main** |

`npm run chantiers` relit les Markdown et fusionne : il réécrit les champs venus des Markdown, et garde tout ce qui a été réglé depuis le tableau. Les deux sources ne se marchent donc pas dessus.

### Les formats

**Un chantier** est une ligne du tableau « Chantiers ouverts » de `docs/CHANTIERS.md` :

```markdown
| id | chantier | état | prochaine action | décisions en attente | doc de reprise | MAJ |
|---|---|---|---|---|---|---|
| CH-04 | API publique | en cours | Pagination, puis limites de débit | Taille de page par défaut | `docs/chantiers/CH-04_api.md` | 2026-03-12 |
```

États reconnus : `pas commencé`, `en cours`, `bloqué`, `terminé`, accents et casse indifférents. Un chantier clos descend dans « Chantiers clos » avec sa preuve. Le journal, en bas du fichier, n'est lu que par les humains.

**Une tâche** est une ligne du backlog, rangée sous la section de son chantier :

```markdown
## CH-04 · API publique

| id | P | tâche | attendu |
|---|---|---|---|
| API-01 | P1 | **Route de lecture.** GET /items, filtrée par compte | Test e2e vert |
| API-02 | P0 | **Pagination.** DÉCISION : curseur ou numéro de page | Test e2e vert |
```

L'id est un préfixe de 2 à 4 lettres majuscules, un tiret et deux chiffres ; il ne se réutilise jamais. Le mot `DÉCISION` marque la tâche « décision attendue » sur le tableau.

**Les lots** (facultatifs) : la spec citée dans la colonne « doc de reprise » peut découper le chantier dans une section `## Découpage`. Chaque ligne numérotée est un lot et nomme ses tâches (`API-01, 02`, `API-03 à 05`). Le tableau regroupe alors les tâches par lot.

### Le cycle d'une tâche

```
a_faire ──▶ en_cours ──▶ a_verifier ──▶ fait
                livrée, pas encore prouvée   preuve citée dans le suivi
              (tout statut) ──▶ abandonne
```

Une tâche livrée n'est pas une tâche faite : `a_verifier` veut dire « commit poussé, pas encore constaté ». Elle passe à `fait` quand une preuve montre son attendu (un test vert sur l'environnement visé, une mesure), et le suivi cite cette preuve.

### Garde-fous

- **Incohérences** : `npm run chantiers -- --strict` sort en erreur si l'état d'un chantier contredit ses tâches. Exemples : chantier « en cours » dont aucune tâche ne bouge, chantier « pas commencé » dont une tâche avance, chantier clos qui garde des tâches ouvertes, chantier sans tâche.
- **Écriture d'une session en tout ou rien** : un id inconnu ou un statut hors vocabulaire n'écrit rien.
- **Verrou par champ** : le tableau n'envoie que les champs modifiés, avec leur valeur au chargement. Si un agent a changé le même champ entre-temps, la saisie est refusée et signalée, jamais écrasée.

---

## Brancher un agent de code

L'agent suit une procédure courte : ouvrir la session dans le journal, passer ses tâches en cours, écrire un suivi à chaque étape, livrer en `a_verifier`, fermer avec `--strict`, et savoir ce que veut dire « Traite le chantier CH-xx ». Le texte de cette procédure est fourni dans [`integrations/`](integrations/), sous deux formes :

| Fichier | Contenu | Pour |
|---|---|---|
| [`claude-code/skills/chantiers/SKILL.md`](integrations/claude-code/skills/chantiers/SKILL.md) | la procédure complète, en skill | Claude Code |
| [`claude-code/CLAUDE.md`](integrations/claude-code/CLAUDE.md) | trois lignes qui renvoient au skill | Claude Code |
| [`codex/AGENTS.md`](integrations/codex/AGENTS.md) | la même procédure complète, en un bloc autonome | Codex et tous les autres agents |

Le bloc `CLAUDE.md` est court parce que Claude Code sait charger un skill à la demande : la procédure n'occupe le contexte que quand la session touche un chantier. Les autres agents lisent leur fichier d'instructions en entier à chaque session : ils reçoivent donc la procédure complète.

### Claude Code

1. Copier le skill dans le projet :
   `integrations/claude-code/skills/chantiers/` → `.claude/skills/chantiers/`
2. Ajouter au `CLAUDE.md` du projet le bloc de [`integrations/claude-code/CLAUDE.md`](integrations/claude-code/CLAUDE.md) :

```markdown
## Suivi des chantiers

Chaque session de travail invoque le skill `chantiers` au début, à chaque étape livrée et à la fin.
```

Claude Code charge le skill de lui-même quand la session touche un chantier ou une tâche. On peut aussi l'appeler directement : `/chantiers`.

> **Claude Code et Codex sur le même projet** : poser le bloc complet dans `AGENTS.md` (voir Codex), puis écrire dans `CLAUDE.md` la seule ligne `@AGENTS.md`. Claude Code importe alors le même texte, et il n'y a plus qu'un fichier à tenir.

### Codex

Ajouter le contenu de [`integrations/codex/AGENTS.md`](integrations/codex/AGENTS.md) au fichier `AGENTS.md` à la racine du projet (le créer s'il n'existe pas). Codex le lit au début de chaque session.

### Autres agents

Le bloc `AGENTS.md` est autonome : il suffit de le placer là où l'agent lit ses instructions.

| Agent | Fichier d'instructions |
|---|---|
| Cursor | `AGENTS.md` à la racine, ou une règle dans `.cursor/rules/` |
| GitHub Copilot | `.github/copilot-instructions.md` (ou `AGENTS.md`, selon le mode) |
| Gemini CLI | `GEMINI.md` |
| Aider | un fichier de conventions passé avec `--read` |
| Tout autre agent | son prompt système ou son fichier de règles |

Dans tous les cas, l'agent a seulement besoin de lancer `npm run chantiers` et d'éditer trois fichiers Markdown. Aucune intégration propre à un outil n'est nécessaire.

> Les deux textes viennent de la même source : `AGENTS.md` est le skill Claude Code sans son en-tête. Pour adapter la procédure, modifier le skill, puis lancer `npm run agents:sync`, qui régénère `integrations/codex/AGENTS.md` (`npm test` signale un écart entre les deux).

---

## Commandes

| Commande | Effet |
|---|---|
| `npm run chantiers` | relit les Markdown et régénère `chantiers.json` |
| `npm run chantiers -- --check` | affiche le résultat et les incohérences, n'écrit rien |
| `npm run chantiers -- --strict` | code de sortie 1 s'il reste une incohérence (fin de session, CI) |
| `npm run chantiers -- --session <nom> --statut ID=<statut> --suivi "ID=<texte>"` | écrit le statut et le suivi d'une tâche, au nom d'une session |
| `npm run chantiers -- --session <nom> --chantier ID=CH-xx` | rattache une tâche à un autre chantier |
| `npm run chantiers -- --session <nom> --lot ID=<n>` | place une tâche dans un lot de la spec |
| `npm run tracker` | sert le tableau sur `http://localhost:4173/` (`-- --port 8080` pour changer) |
| `npm run code:stats` | ajoute le relevé du jour à l'onglet « Code » (`-- --check` : affiche seulement) |
| `npm run agents:sync` | régénère le bloc `AGENTS.md` depuis le skill Claude Code (dans ce dépôt) |
| `npm test` | tests de l'outil |

`--statut`, `--suivi`, `--chantier` et `--lot` sont répétables dans une même commande. Statuts : `a_faire`, `en_cours`, `a_verifier`, `fait`, `abandonne`. Toutes les commandes acceptent `--root <dossier>` ; sinon la racine du projet est le premier dossier parent qui contient `tracker.config.json`.

Exemple de passage d'un agent :

```bash
npm run chantiers -- --session api-pagination \
  --statut API-02=a_verifier \
  --suivi "API-02=pagination par curseur livrée (commit 4f2c1e9), test e2e à rejouer sur la préproduction"
```

---

## Le tableau

| Vue | Contenu |
|---|---|
| **Priorisation** | chantiers ouverts par priorité (P0 à P3), réordonnables au glisser-déposer ou au clavier |
| **Tableau** | kanban par état : pas commencé, en cours, bloqué, terminé |
| **Tâches** | toutes les tâches, filtrables et triables ; statut, priorité, chantier, lot et note modifiables sur place |
| **Terminés & clos** | chantiers fermés, avec leur preuve |
| **Code** | lignes de code et de tests par groupe, avec l'historique |

Chaque chantier s'ouvre dans une fiche : état, prochaine action, décisions, liens vers ses docs, tâches groupées par lot, note du responsable. Le tableau relit le fichier toutes les 15 secondes : ce qu'un agent vient d'écrire apparaît sans recharger la page.

Accessibilité : navigation complète au clavier, fiche en boîte de dialogue modale, contrastes de 4,5:1 au moins dans les thèmes clair et sombre, tailles en `rem` (zoom à 200 %). Sur téléphone, les tâches passent en cartes.

### Deux façons de le servir

- **Node** (recommandé) : `npm run tracker`. N'écoute que sur `127.0.0.1`.
- **Apache + PHP** (WAMP, MAMP, XAMPP, ou tout serveur local déjà en place) : placer le projet sous la racine web et ouvrir `http://localhost/<projet>/docs/tracker/`. Les enregistrements passent par `docs/tracker/save.php`, qui parle le même protocole que le serveur Node.

Ouvrir `index.html` directement depuis le disque (`file://`) ne fonctionne pas : le navigateur interdit alors la lecture du fichier de données.

---

## Relevé du code

`npm run code:stats` compte, par groupe de dossiers, les lignes brutes, les lignes non vides, les fichiers et, pour les tests, les cas déclarés. Un relevé par jour : relancer la commande le même jour remplace le relevé du jour, et l'historique se construit au fil des jours.

Les groupes se décrivent dans `tracker.config.json`, clé `code.groupes` :

```json
{
    "cle": "api",
    "libelle": "API",
    "production": true,
    "racines": ["services/api/src"],
    "suffixes": [".ts"],
    "tests": "exclure"
}
```

| Champ | Rôle |
|---|---|
| `production` | `true` : compté dans « Total production » ; `false` : dans « Total tests » |
| `racines` | dossiers parcourus, relatifs à la racine du projet |
| `suffixes` | extensions retenues |
| `tests` | `exclure` (code seul), `seulement` (tests seuls) ou `tous` |
| `cas` | `true` : compte aussi les cas de test déclarés |

Un fichier est un test par son nom (`*.test.ts`, `*.spec.js`, `test_*.py`, `*_test.go`, `*Test.php`) ou par son dossier (`test/`, `tests/`, `__tests__/`, `e2e/`). Les cas de test se comptent sur les déclarations : `it(…)` et `test(…)` en JavaScript et TypeScript, `def test_…` en Python, `func Test…` en Go, `function test…` en PHP. C'est un plancher, car les tests paramétrés en produisent davantage à l'exécution.

### Relevé automatique

**Windows** : une tâche planifiée, deux relevés par jour (08:30 et 20:30). Un poste éteint à l'heure prévue rattrape le relevé au démarrage.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/worklog/install-code-stats-task.ps1
# autres heures : ... -At 09:00,18:00
```

**Linux et macOS** : une ligne `crontab -e`.

```cron
30 8,20 * * * cd /chemin/du/projet && node scripts/worklog/code-stats.mjs >> /tmp/code-stats.log 2>&1
```

---

## Réglage

`tracker.config.json`, à la racine du projet. Toute clé absente prend sa valeur par défaut.

| Clé | Défaut | Rôle |
|---|---|---|
| `projet` | nom du dossier | nom affiché en tête du tableau |
| `chantiers` | `docs/CHANTIERS.md` | registre des chantiers |
| `backlog` | `docs/chantiers/backlog.md` | backlog des tâches |
| `specs` | `docs/chantiers` | dossier des specs (`CH-xx_*.md`) |
| `tracker` | `docs/tracker` | dossier du tableau et de ses données |
| `ui.accent` / `ui.accentSombre` | `#3538cd` / `#a4a6ff` | couleur d'accent, thème clair et sombre (viser 4,5:1 sur le fond) |
| `ui.marque` | `DÉCISION` | mot qui marque une tâche « décision attendue » |
| `ui.marqueFiltre` / `ui.marqueKpi` | `Décision attendue` / `décisions attendues` | libellés du filtre et de l'indicateur |
| `serveur.port` | `4173` | port de `npm run tracker` |
| `code.exclus` | `node_modules`, `dist`, `.git`… | dossiers jamais parcourus par le relevé |
| `code.groupes` | — | groupes du relevé (voir plus haut) |
| `code.compterOutil` | `false` | `true` : le relevé compte aussi `scripts/worklog/` (l'outil lui-même) |

Le réglage arrive au tableau par `chantiers.json` : après un changement, relancer `npm run chantiers`.

---

## Sécurité

Le tableau est un outil **local**.

- Le serveur Node n'écoute que sur `127.0.0.1` et ne sert aucun chemin dont un segment commence par un point (`.env`, `.git`…).
- Les écritures n'acceptent que du JSON envoyé par une page du tableau lui-même (en-tête `Sec-Fetch-Site`) : une autre page ouverte dans le navigateur ne peut pas modifier les données.
- `save.php` refuse toute requête qui ne vient pas du poste local (`127.0.0.1`, hôte `localhost`, sans `X-Forwarded-For`).
- Seuls les champs du tableau s'écrivent (priorité, rang, statut, rattachement, lot, note) ; les Markdown ne sont jamais modifiés par le tableau.

Ne l'exposez pas sur un réseau. Avec Apache, vérifiez que le serveur ne sert pas les fichiers cachés du projet (`.env`, `.git/`).

---

## Structure du dépôt

```
agent-worklog/
├── docs/
│   ├── CHANTIERS.md              modèle : registre des chantiers et journal
│   ├── chantiers/
│   │   ├── backlog.md            modèle : backlog des tâches
│   │   └── CH-01_exemple.md      modèle : spec d'un chantier, découpage en lots
│   └── tracker/                  le tableau (HTML, CSS, JS sans dépendance) et save.php
├── scripts/worklog/
│   ├── chantiers-tracker.mjs     npm run chantiers
│   ├── serve.mjs                 npm run tracker
│   ├── patch.mjs                 enregistrement du tableau (verrou par champ)
│   ├── code-stats.mjs            npm run code:stats
│   ├── config.mjs                lecture de tracker.config.json
│   ├── install.mjs               installation dans un projet
│   ├── sync-agents.mjs           npm run agents:sync
│   ├── install-code-stats-task.ps1
│   └── worklog.test.mjs          npm test
├── integrations/
│   ├── claude-code/              skill et bloc CLAUDE.md
│   └── codex/                    bloc AGENTS.md
└── tracker.config.json
```

## Licence

[MIT](LICENSE).
