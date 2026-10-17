# Backlog

Une section par chantier (`## CH-xx · titre`) : la section donne le chantier par défaut de chaque tâche qu'elle contient. Une tâche par ligne de tableau : `| id | priorité | tâche | attendu |`.

- **id** : un préfixe de 2 à 4 lettres majuscules propre au chantier, un tiret, deux chiffres (`API-01`, `UI-12`). Un id ne se réutilise jamais : une tâche abandonnée garde le sien (statut `abandonne`).
- **priorité** : `P0` (bloquant) à `P3` (quand on aura le temps).
- **tâche** : `**Titre court.** détail` ; le titre s'affiche dans le tableau, le détail dans la fiche.
- **attendu** : ce qui prouve que c'est fait (un test, une mesure, un écran).
- Le mot `DÉCISION` dans une ligne la marque « décision attendue » sur le tableau.

Ce fichier porte ce qu'il faut faire. Le STATUT et le SUIVI de chaque tâche vivent dans `docs/tracker/chantiers.json`, écrits par `npm run chantiers -- --session … --statut … --suivi …` ou par le tableau ; jamais ici.

État et prochaine action des chantiers : [`docs/CHANTIERS.md`](../CHANTIERS.md).

## CH-01 · Exemple : mise en place du suivi des chantiers

| id | P | tâche | attendu |
|---|---|---|---|
| SUI-01 | P1 | **Brancher l'agent de code.** Copier le bloc d'instructions (`AGENTS.md`, `CLAUDE.md` ou autre) dans le projet | L'agent ouvre une ligne de journal `OUVERT` au début de sa session |
| SUI-02 | P1 | **Écrire les vrais chantiers.** Une ligne par chantier dans `docs/CHANTIERS.md`, ses tâches ici | `npm run chantiers -- --strict` sans INCOHÉRENCE |
| SUI-03 | P2 | **Régler le relevé de code.** Groupes de `tracker.config.json` (clé `code`) adaptés aux dossiers du projet | L'onglet « Code » montre des chiffres non nuls |
| SUI-04 | P3 | **Relevé automatique.** DÉCISION : tâche planifiée (Windows ou cron) ou relevés à la main | Un relevé par jour dans l'onglet « Code », ou tâche abandonnée par choix |
