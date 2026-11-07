# Serveur Firebase — préparation locale

État vérifié le 4 novembre 2026. Aucun déploiement, aucune activation de facturation et aucune modification de données de production n’ont été effectués. Cette préparation ne rend pas le jeu public prêt à fonctionner.

## Architecture et autorité

- `index.js` expose la fonction callable `gameAction` dans `europe-west1`. L’auteur provient de `request.auth.uid`, pas des paramètres du navigateur.
- `game-service.js` accepte uniquement un identifiant d’action, un type connu et les paramètres exacts de ce type. Soldes, inventaires, horloge et tirages ne sont pas acceptés comme état fourni par le client.
- Le service lit les participants et applique les transitions avec le SDK Admin dans une transaction Firestore. Le navigateur n’a pas à lire les profils des autres joueurs.
- `events/{id}` contient un reçu créé avec les modifications. Rejouer le même identifiant et les mêmes paramètres renvoie le résultat enregistré ; réutiliser cet identifiant avec un autre auteur ou contenu est refusé. Ne pas supprimer ces reçus sans concevoir une nouvelle politique d’idempotence.
- Une réservation débite le booster et conserve son tirage privé dans `packSecrets/{id}`. L’ouverture attribue les cartes, supprime le secret et conserve les identifiants révélés dans le reçu, afin de retrouver le résultat après une réponse perdue.
- `firestore.rules` refuse toutes les écritures directes du navigateur, limite la lecture des profils et reçus à leur propriétaire et réserve la lecture du marché aux utilisateurs authentifiés avec une limite de requête de 40. Les secrets ne sont pas lisibles par le client, même par leur acheteur.
- Les écritures Admin ne sont pas validées par ces règles clientes : les validations économiques sont dans le service et le modèle partagé. Une règle fermée ne remplace donc pas les contrôles du serveur.

Le catalogue et le modèle sont copiés depuis `../catalog.js` et `../pages/game-model.js` par `../build-functions.js`. Les fichiers de `generated/` sont ignorés par Git et doivent être régénérés avant un import ou un test du service. Les tirages déterministes du modèle local ne sont pas utilisés pour attribuer les boosters du service serveur.

## Commandes depuis la racine du dépôt

```sh
npm ci --prefix functions --ignore-scripts --no-audit --no-fund
npm run build:functions
npm run check:functions
npm run test:functions
npm run test:rules
npm run test:pages:gateway
```

L’installation initiale des SDK serveur et leurs imports ont été vérifiés. La commande `npm ci` ci-dessus indique comment réinstaller à partir du verrouillage ; une réinstallation propre avec cette commande n’a pas été vérifiée pendant cette tâche. L’installation racine du navigateur et sa construction regroupée restent un sujet distinct ; la variante CDN a été construite et testée.

### Prérequis des tests Firestore actuels

Les scripts sont actuellement adaptés au poste Windows utilisé pour cette vérification. Ils attendent, depuis la racine :

- `.frst/security-tools/java/jdk-21.0.13+9-jre/bin/java.exe` ;
- `.frst/security-tools/cloud-firestore-emulator-v1.22.0.jar` ;
- pour ce JAR, l’empreinte SHA-256 `9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c`.

Ces exécutables et les rapports `.frst/` ne sont pas versionnés. Leur absence sur un autre poste est un prérequis manquant, pas un test réussi. Une procédure d’installation portable reste à préparer.

Les scripts démarrent leur propre émulateur Java sur une adresse `127.0.0.1` et un port libre, avec un projet `demo-` dédié, puis l’arrêtent. Ils ne nécessitent pas de connexion à un compte Firebase. Ils n’utilisent pas le projet public configuré dans le navigateur. Ne pas remplacer le projet de démonstration ou l’adresse locale par une base distante pour faire passer les tests.

`firebase.json` prépare aussi des ports locaux pour Authentication, Firestore et Functions. Le parcours complet avec ces trois émulateurs n’a pas été vérifié : les tests du service démarrent directement l’émulateur Firestore, pas le point d’entrée HTTP Cloud Functions. Le seul fichier de configuration ne prouve pas que la suite complète démarre.

## Résultats et périmètre

| Vérification | Résultat observé | Ce qu’elle ne prouve pas |
| --- | --- | --- |
| Service avec SDK Admin et véritable émulateur Firestore | 13 tests réussis | Validation des jetons Auth, App Check, transport callable HTTP ou production |
| Règles sur émulateur, requêtes REST avec identités de test | 9 groupes réussis, y compris les secrets privés | Validation des véritables jetons Authentication ou déploiement des règles |
| Suivi local du navigateur avec transport simulé | 11 tests réussis | Fonctionnement du SDK Firebase ou du réseau réel |
| Modèle partagé | 15 tests réussis | Autorisation distante |
| Serveur SQLite existant | 18 tests réussis | Fonctionnement de la variante Firebase |
| Interface visiteur CDN dans Chromium | 11 contrôles réussis | Parcours connecté et transactions Firebase |

Rapports : `.frst/functions-test-result.json`, `.frst/firestore-rules-test-result.json`, `.frst/pages-gateway-test-result.json` et `.frst/pages-browser-test-result.json`. Vérifier `status`, les nombres de contrôles et, pour les émulateurs, `emulatorStopped`. Le rapport du service garde `callableHttpVerified` et `productionVerified` à `false`. Celui des règles garde `gameWriteRulesVerified` à `false` : aucune écriture économique cliente n’est autorisée par cette architecture.

Aucun vérificateur ESLint ou TypeScript n’est configuré. Les contrôles `node --check` portent sur la syntaxe, pas sur un audit de sécurité.

## Avertissements et limites restantes

- Le runtime déclaré pour les fonctions est Node.js 22 ; l’exécution locale a utilisé Node.js 24.19.0. npm a signalé cette différence avec `EBADENGINE`. La compatibilité dans le runtime déclaré reste à vérifier.
- L’installation a signalé les dépendances transitives dépréciées `node-domexception@1.0.0` et `glob@10.5.0`. Le message concernant glob mentionne des vulnérabilités connues ; aucune analyse de leur applicabilité ni correction des dépendances n’a été validée ici.
- Le SDK a émis un `MetadataLookupWarning` avec `ETIMEDOUT` et `ENOTFOUND` pendant la détection de son environnement. Les opérations Firestore testées ciblent l’émulateur, mais l’exécution n’est pas une preuve d’isolation réseau totale ni de fonctionnement entièrement hors ligne. Ne pas fournir d’identifiants réels pour masquer cet avertissement.
- App Check est imposé par le point d’entrée hors émulateur, mais aucun fournisseur n’est encore initialisé dans le navigateur. Il faut intégrer et tester cette partie avant publication ; ne pas désactiver l’exigence pour contourner le blocage.
- Les index de `../firestore.indexes.json` sont préparés, pas déployés. Les tests sur émulateur ne valident pas leur disponibilité dans un environnement cible.
- Il reste à tester l’authentification réelle, les jetons invalides, les domaines autorisés, le parcours connecté, les coupures et reprises dans l’interface, ainsi que l’ensemble du transport callable.
- Les limites d’instances ne constituent pas une politique complète de limitation par utilisateur ou de maîtrise des coûts. Supervision, budgets, sauvegardes, nettoyage des données et protection contre les créations abusives de comptes restent à concevoir et vérifier.
- Une transaction locale corrompue ou une reprise au résultat ambigu reste bloquante par prudence. Une procédure de réconciliation est nécessaire ; supprimer aveuglément le suivi local peut faire perdre l’identifiant à rejouer.
- Les enchères Firebase expirées sont clôturées par une action en ligne d’un participant. Aucun ordonnanceur automatique n’est fourni.

Le choix approuvé porte sur la préparation locale uniquement. Un éventuel déploiement, la configuration des services et toute activation de facturation demandent une autorisation distincte.
