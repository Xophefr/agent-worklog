# Suivi des chantiers

**Registre unique de ce qui est en cours, de ce qui attend une décision, et de qui a fait quoi.**
Ce tableau porte l'ÉTAT de chaque chantier ; son doc de reprise porte le DÉTAIL ; les tâches sont dans [`docs/chantiers/backlog.md`](chantiers/backlog.md). Ne pas recopier l'un dans l'autre.

Le tableau de suivi (`docs/tracker/`) lit `docs/tracker/chantiers.json`, que construit `npm run chantiers` à partir de ce fichier et du backlog.

## Ce que fait CHAQUE session

1. **À l'ouverture** : lire le tableau, puis ajouter une ligne de journal `OUVERT` (date, session, chantier visé). Passer en `en_cours` les tâches traitées : `npm run chantiers -- --session <nom> --statut ID=en_cours --suivi "ID=ce que la session va faire"`.
2. **En cours de route** : à chaque étape qui change ce que le responsable verrait (décision, lot de code écrit, tests verts, commit poussé), une ligne de `--suivi` par tâche touchée.
3. **À la livraison** : les tâches livrées passent en `a_verifier` (livré, pas encore constaté). **À la constatation** (test vert sur l'environnement visé, mesure faite) : `fait`, avec dans le suivi ce qui a été constaté et où.
4. **À la fermeture** : mettre à jour LA ligne du chantier (état, prochaine action, décisions, date) et ajouter une ligne de journal `FERMÉ` avec les commits et les docs touchés. Puis `npm run chantiers -- --strict` : aucune INCOHÉRENCE sur le chantier.
5. **Nouveau chantier** : nouvelle ligne, id `CH-xx` libre, un doc de reprise nommé, et ses tâches dans une nouvelle section `## CH-xx · titre` du backlog. Un chantier sans tâche ne se mesure pas.
6. **Chantier terminé** : état `terminé`, et la ligne descend dans « Chantiers clos » quand ses tâches sont constatées. On ne supprime pas une ligne, on la déplace.
7. **Une affirmation d'état porte sa preuve** : un commit, une mesure datée, ou « à vérifier ».
8. **Une décision en attente se pose au responsable** avant la fermeture (question, options, recommandation). La colonne « décisions en attente » garde la trace, elle ne remplace pas la question.
9. **Écriture concurrente** : en cas de conflit git, garder les DEUX lignes du journal ; il est en ajout seul.

---

## Chantiers ouverts

États : `en cours` · `bloqué` (attend un arbitrage) · `pas commencé` · `terminé` (en attente de constat, puis de descente vers les chantiers clos).

| id | chantier | état | prochaine action | décisions en attente | doc de reprise | MAJ |
|---|---|---|---|---|---|---|
| CH-01 | Exemple : mise en place du suivi des chantiers | pas commencé | Remplacer ce chantier d'exemple par les vrais chantiers du projet | Garder ou retirer le relevé automatique du code | `docs/chantiers/CH-01_exemple.md` | 2026-01-01 |

## Chantiers clos

Un chantier ABANDONNÉ (pas mené à terme) descend ici aussi, avec `**ABANDONNÉ**` dans sa colonne « chantier ».

| id | chantier | clos le | preuve | ce qui en reste |
|---|---|---|---|---|

## Journal

En ajout seul : une ligne par ouverture, étape notable ou fermeture de session.

| date | session | chantier | ce qui s'est passé | commits | docs touchés |
|---|---|---|---|---|---|
| 2026-01-01 | init | CH-01 | OUVERT. Mise en place du suivi des chantiers | — | `docs/CHANTIERS.md`, `docs/chantiers/backlog.md` |
