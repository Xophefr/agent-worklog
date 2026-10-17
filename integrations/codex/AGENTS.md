## Suivi des chantiers (à faire à chaque session)

À suivre au DÉBUT de toute session de travail, à CHAQUE étape livrée et à la FIN.

Le responsable du projet suit le travail sur le TABLEAU (`docs/tracker/`, ouvert par
`npm run tracker`), pas dans le terminal. Un tableau en retard sur le code est un tableau
faux : il affiche « à faire » sur ce qui tourne déjà, ou « en cours » sur ce qui est livré
depuis trois jours. Il se tient donc à jour PENDANT la session.

### Les objets, et qui les écrit

| Objet | Porte | Écrit par |
|---|---|---|
| `docs/CHANTIERS.md` -- tableau | l'ÉTAT de chaque chantier (une ligne) | la session, à la main |
| `docs/CHANTIERS.md` -- journal | ce qui s'est passé (AJOUT SEUL) | la session, une ligne par ouverture / fermeture |
| `docs/chantiers/backlog.md` | les TÂCHES (id, priorité, titre, attendu), rangées sous `## CH-xx · titre` | la session, à la main |
| `docs/tracker/chantiers.json` | statut + suivi des tâches, priorité / rang / notes du responsable | `npm run chantiers` et le tableau, JAMAIS à la main |
| `docs/chantiers/CH-xx_*.md` | le DÉTAIL d'un chantier (décisions, mesures, découpage en lots, reprise) | la session |

Les chemins exacts sont dans `tracker.config.json`. Le champ `note` est au responsable ; la
session écrit dans `suivi`.

### Les commandes

```bash
npm run chantiers                         # relit CHANTIERS.md + backlog, régénère le JSON
npm run chantiers -- --session <nom> \
  --statut API-01=en_cours \
  --suivi "API-01=ce qui vient d'être fait et ce qui reste, en une phrase"
npm run chantiers -- --strict             # à la fermeture : code 1 s'il reste une INCOHÉRENCE
npm run chantiers -- --check              # affiche seulement, n'écrit rien
npm run code:stats                        # relevé des lignes de code et de tests (onglet « Code »)
```

`--statut`, `--suivi`, `--chantier ID=CH-xx` et `--lot ID=N` sont répétables ; `--session`
est obligatoire avec eux (nom court : branche, worktree ou lot). Statuts : `a_faire`,
`en_cours`, `a_verifier`, `fait`, `abandonne`. Tout ou rien : un id inconnu ou un statut hors
vocabulaire n'écrit rien. Relancer `npm run chantiers` après toute modification de
`CHANTIERS.md` ou du backlog : le tableau ne lit que le JSON (il se recharge seul toutes les 15 s).

Sous PowerShell, passer les textes de `--suivi` entre guillemets doubles.

### Le cycle, dans l'ordre

1. **Ouverture** (avant tout code) : lire la ligne du chantier dans `docs/CHANTIERS.md` et son
   doc ; ajouter une ligne de journal `OUVERT` ; passer en `en_cours` les tâches traitées,
   avec un `--suivi` qui dit ce que la session va faire. Si le travail demandé n'a pas de
   tâche : l'AJOUTER au backlog d'abord, puis la passer en `en_cours`.
2. **En temps réel** (à chaque étape qui change ce que le responsable verrait : décision,
   lot de code écrit, tests verts, commit poussé) : une ligne de `--suivi` par tâche touchée.
   Le suivi dit OÙ on en est et CE QUI RESTE.
3. **Livraison** (commit poussé, déploiement fait) : `a_verifier` -- livré, pas encore
   constaté. Le suivi nomme les commits et ce qui reste à constater.
4. **Constat** : une tâche passe à `fait` quand une preuve montre son attendu (test vert sur
   l'environnement visé, mesure, commande) ; le suivi cite la preuve. Pas de preuve pour
   l'attendu : l'écrire d'abord (un test, de préférence).
5. **Fermeture** : mettre à jour LA ligne du chantier (état, prochaine action, décisions en
   attente, date) ; ajouter une ligne de journal `FERMÉ` (commits, docs touchés, ce qui reste) ;
   `npm run chantiers -- --strict` sans INCOHÉRENCE sur son chantier ; commiter ses propres
   chemins (`docs/CHANTIERS.md`, `docs/chantiers/backlog.md`, `docs/tracker/chantiers.json`).

### « Traite le chantier CH-xx »

Cette consigne seule suffit : tout le contexte est dans le dépôt.

1. Lire la ligne du chantier dans `docs/CHANTIERS.md` (état, prochaine action, décisions en
   attente) et sa spec (doc de reprise : décisions, découpage en lots, section « Reprise »).
2. Lister ses tâches ouvertes (`a_faire`, `en_cours`) dans `docs/tracker/chantiers.json` ;
   commencer par le premier lot non fini, puis par priorité (P0 d'abord).
3. Une décision en attente bloque une tâche : la POSER au responsable (options,
   recommandation) avant d'écrire le code qui en dépend ; avancer en attendant sur le reste.
4. Dérouler le cycle ci-dessus : ouverture, suivi à chaque étape, livraison, constat.
5. Avant de s'arrêter : section « Reprise » de la spec et ligne du chantier à jour, pour
   que la même consigne, à la session suivante, reprenne exactement là.

### Nouveau chantier, nouvelle tâche

- **Tâche** : une ligne `| PRE-nn | P1 | **Titre.** détail | attendu |` dans la section du
  chantier du backlog. Préfixe de 2 à 4 lettres majuscules propre au chantier, numéro suivant,
  jamais réutilisé. Le mot `DÉCISION` dans la ligne la marque « décision attendue » sur le tableau.
- **Chantier** : une ligne dans « Chantiers ouverts » (id `CH-xx` libre suivant, état,
  prochaine action, décisions, doc de reprise, date) ET une section `## CH-xx · titre` dans le
  backlog avec ses tâches. Un chantier vivant sans tâche est signalé INCOHÉRENCE.
- **Déplacer une tâche** vers un autre chantier : `--chantier ID=CH-yy` ET déplacer sa ligne
  dans le backlog.
- **Lots** (facultatif) : une spec `docs/chantiers/CH-xx_titre.md` citée dans la colonne doc,
  avec une section `## Découpage` en liste numérotée dont chaque ligne nomme ses tâches
  (`API-02, 05`, `API-01 à 04`). Le tableau regroupe alors les tâches par lot.
- **Chantier terminé** : état `terminé` tant que des tâches sont `a_verifier` ; une fois
  constatées (`fait`), la ligne descend dans « Chantiers clos » (id, chantier, clos le,
  preuve, ce qui en reste).

### Règles

- **Une décision qui revient au responsable se POSE** (question, options, recommandation)
  avant la fermeture ; la colonne « décisions en attente » n'est qu'un rappel.
- **Une tâche livrée n'est pas une tâche faite** : `a_verifier` = livrée, pas encore prouvée.
- **Journal en ajout seul** : en conflit git sur `CHANTIERS.md`, garder les DEUX lignes.
- **Aucun secret** (clé, mot de passe, valeur d'un `.env`) dans un suivi, une note, le registre
  ou le journal.
- **Plusieurs sessions en parallèle** : ne commiter que ses propres chemins et ses propres lignes.

### Fin de tâche -- liste à cocher

- [ ] tâches du périmètre : statut juste (`a_verifier` ou `fait`) et suivi à jour
- [ ] ligne du chantier : état, prochaine action, décisions, date
- [ ] journal : ligne `FERMÉ` (ou `OUVERT` si la session s'arrête au milieu)
- [ ] spec du chantier : ce qui a été fait, mesuré, décidé ; point de départ suivant
- [ ] `npm run chantiers -- --strict` : zéro INCOHÉRENCE sur le chantier
- [ ] commit de ses propres chemins
