# Contribuer à agent-worklog

Merci de prendre le temps d'améliorer l'outil. Les correctifs, les signalements de bugs et les idées sont bienvenus.

## Signaler un problème

Ouvrez une issue avec :

- ce que vous avez lancé (commande exacte, `npm run chantiers -- --check` par exemple) ;
- ce que vous attendiez, et ce qui s'est passé ;
- votre version de Node.js (`node -v`) et votre système ;
- si possible, un extrait minimal de `CHANTIERS.md` ou de `backlog.md` qui reproduit le problème.

Pour une faille de sécurité, n'ouvrez pas d'issue publique : passez par l'onglet **Security** du dépôt (« Report a vulnerability »).

## Proposer un correctif

1. Forkez le dépôt, puis créez une branche depuis `main` (`fix/…` ou `feat/…`).
2. Faites votre modification.
3. Lancez les tests :

   ```bash
   npm test
   ```

4. Si vous avez modifié le skill `integrations/claude-code/skills/chantiers/SKILL.md`, régénérez le bloc Codex, sinon `npm test` signalera l'écart :

   ```bash
   npm run agents:sync
   ```

5. Décrivez le changement dans la pull request (Ajouté, Modifié, Corrigé), et ce qu'un projet déjà installé doit adapter s'il y a lieu. [`CHANGELOG.md`](CHANGELOG.md) ne décrit que ce qui est livré : sa section est écrite à la publication de la version qui contient le changement.

6. Ouvrez une pull request vers `main` en expliquant le problème corrigé et la façon dont vous l'avez vérifié.

Une PR courte, centrée sur un seul sujet, se relit et se fusionne plus vite.

## Règles du projet

- **Aucune dépendance npm, sauf les pilotes de base du BFF.** L'outil tourne avec Node.js 20 ou plus. Seul le BFF du mode base (`scripts/worklog/bff.mjs`, `scripts/worklog/base/`) dépend de `pg` et `mysql2`, installés dans ce dépôt par `npm install` ; rien de cela ne part dans un projet suivi, qui reste sans `node_modules`. Une PR qui ajoute une autre dépendance sera refusée, sauf discussion préalable dans une issue.
- **Le tableau reste accessible** : navigation au clavier, contrastes de 4,5:1 au moins dans les deux thèmes, tailles en `rem`.
- **Le serveur reste local** : pas d'écoute hors de `127.0.0.1`, pas d'affaiblissement des contrôles décrits dans la section Sécurité du README.
- **Les formats Markdown sont un contrat** : un changement dans la lecture de `CHANTIERS.md`, du backlog ou des specs doit rester compatible avec les fichiers existants, ou être signalé clairement dans la PR.
- Le code, les messages et la documentation sont en français.

## Licence

En proposant une contribution, vous acceptez qu'elle soit publiée sous la licence MIT du projet.
