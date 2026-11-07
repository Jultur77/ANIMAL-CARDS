# Animal Cards

Jeu multijoueur de collection et de commerce de cartes animales, avec un client navigateur et un serveur Node.js utilisant SQLite. Le marché contient les propositions des joueurs réels : aucun acheteur ou vendeur artificiel n’est ajouté.

## Lancer le jeu

Prérequis : Node.js 24, version 24.15.0 minimum, et npm.

```sh
npm ci
node prepare-assets.js --offline
npm start
```

Ouvrir http://localhost:3000 et créer un compte. Pour jouer avec deux comptes sur la même machine, utiliser deux profils de navigateur ou une fenêtre privée.

Le serveur écoute par défaut sur `0.0.0.0:3000`. Pour un usage limité à la machine, définir `HOST=127.0.0.1` dans un fichier `.env`. Les scripts `start` et `dev` chargent ce fichier lorsqu’il existe.

```sh
npm run dev
```

## Fonctionnement

- Catalogue de 56 espèces et sept niveaux de rareté.
- Boutique personnelle renouvelée toutes les cinq minutes, avec stocks limités.
- Boosters de quatre cartes, avec une rareté minimale garantie selon le booster.
- Inventaire avec recherche et filtres, et Index des espèces découvertes.
- Découvertes conservées dans l’Index après une vente ou un échange.
- Revenus passifs, avec rattrapage plafonné à 24 heures.
- Ventes à prix fixe, enchères avec réservation des fonds, échanges de cartes et historique des ventes.
- Progression enregistrée dans SQLite et sessions individuelles.

Les pièces sont une monnaie virtuelle interne au jeu.

Les transferts et achats sont validés côté serveur dans des transactions. Une carte proposée à la vente ou à l’échange est verrouillée jusqu’à la résolution ou à l’annulation autorisée de la proposition.

### Connexion interrompue pendant un achat

Le client conserve l’identifiant de l’action en attente et propose de reprendre la même transaction. Le serveur reconnaît une action déjà exécutée : la reprise ne doit pas facturer une seconde fois ni dupliquer les cartes. Ne pas effacer le stockage du navigateur avant d’avoir résolu une action en attente.

## Illustrations et crédits

Le jeu fonctionne sans service d’images externe grâce aux illustrations emoji de secours.

```sh
node prepare-assets.js --offline
```

Cette commande prépare les ressources locales sans téléchargement. Pour tenter d’importer des photographies avec leurs crédits :

```sh
npm run assets
```

Le script vérifie les informations d’auteur et de licence, conserve les références dans `public/animals/manifest.json` et interrompt les téléchargements en cas de refus ou de limitation réseau. Le client n’utilise que les ressources locales renseignées dans le manifeste. Les crédits sont accessibles depuis l’interface.

État de la préparation effectuée : aucune photographie téléchargée ; les 56 espèces utilisent les illustrations emoji. La tentative a notamment rencontré une limitation HTTP 429. Les photographies et leur vérification restent donc à compléter ; il ne s’agit pas d’un catalogue photographique finalisé.

L’option `--strict` permet de considérer les illustrations manquantes comme une erreur lors de la préparation.

## Vérifications

```sh
npm run check
npm test
npx --no-install playwright install chromium
npm run test:browser
```

- `check` contrôle la syntaxe du serveur, du catalogue, du stockage et du client.
- `test` exécute 18 tests portant notamment sur les probabilités, les stocks, les transactions, les réservations d’enchères, les échanges, les sessions, la persistance et les protections de l’API.
- `test:browser` vérifie dix scénarios avec deux comptes isolés dans Chromium, notamment les transactions réelles, la reprise d’une réponse perdue et la navigation mobile.

Les tests navigateur utilisent un serveur de test et une base en mémoire, sans modifier la progression de la base habituelle. Leurs captures sont enregistrées dans `.frst/screenshots/`.

Le test ciblé `npm run test:mobile` vérifie l’inventaire aux largeurs 320, 360, 390, 414 et 768 pixels, ainsi que la déconnexion et la reconnexion avec conservation des cartes. Les mesures attendent deux trames de rendu après chaque redimensionnement. Le rapport détaillé est enregistré dans `.frst/mobile-test-result.json`.

Si le lancement via npm ne produit pas les dix résultats, exécuter directement `node browser.test.js`. Un code de sortie seul, sans les résultats des scénarios, ne suffit pas à confirmer leur exécution complète. Le rapport `.frst/browser-test-result.json` doit indiquer `status: "passed"` et `checks: 10` pour confirmer la fin des scénarios. Un rapport resté à `running` ne valide pas le test.

Dernière vérification ciblée : test mobile réussi aux cinq largeurs et reconnexion vérifiée. La validation complète des dix scénarios après les dernières modifications reste à confirmer : les dernières exécutions n’ont renvoyé qu’une partie des résultats malgré un code de sortie nul.

Aucun vérificateur ESLint ou TypeScript n’est configuré : le contrôle de syntaxe ne remplace pas un audit du code.

## Configuration et données

Variables du serveur :

| Variable | Valeur par défaut | Usage |
| --- | --- | --- |
| `PORT` | `3000` | Port HTTP |
| `HOST` | `0.0.0.0` | Interface d’écoute |
| `DATABASE_PATH` | `data/animal-cards.sqlite` | Chemin de la base persistante |
| `APP_ORIGIN` | non définie | Origine publique autorisée |
| `NODE_ENV` | non définie | Mode de production et cookies sécurisés |

Pour une mise en ligne, prévoir HTTPS, une origine publique explicite et un stockage persistant pour SQLite. Sauvegarder les données avec le serveur arrêté et vérifier la restauration avant d’en dépendre.

`.gitignore` exclut notamment les dépendances, les données locales, les fichiers `.env`, les bases SQLite et les captures de travail. Ne pas publier de secrets ni de données de joueurs.

## Fichiers principaux

- `catalog.js` : espèces, raretés et tirages.
- `store.js` : économie et transactions SQLite.
- `server.js` : serveur HTTP, comptes, sessions et API.
- `public/index.html`, `public/styles.css`, `public/app.js` : interface du jeu.
- `prepare-assets.js` : préparation des illustrations et des crédits.
- `game.test.js`, `browser.test.js` : tests serveur et navigateur.

Les tests locaux ne constituent ni un audit de sécurité, ni un test de charge, ni une validation d’un déploiement public.

## Version statique en préparation : GitHub Pages et Firebase

Cette seconde interface se trouve dans `pages/`. Elle ne remplace pas le serveur SQLite décrit ci-dessus : ses comptes et ses données utilisent Firebase Authentication et Firestore, tandis que le serveur existant conserve son propre fonctionnement.

**État au 4 novembre 2026 : autorité serveur préparée et testée localement ; jeu Firebase non validé pour une publication publique.** Le navigateur appelle désormais la fonction `gameAction`, préparée dans `functions/`. Le serveur calcule les transitions et écrit les profils, offres et reçus dans une transaction atomique. Les règles `firestore.rules` interdisent toutes les écritures directes du client et conservent les profils privés. Les tirages réservés restent dans une collection inaccessible au navigateur jusqu’à leur ouverture.

Aucune fonction ni règle n’a été déployée, aucune facturation n’a été activée. Le point d’entrée impose App Check hors émulateur, mais son fournisseur côté navigateur n’est pas encore intégré : le parcours connecté ne doit donc pas être présenté comme prêt à publier. Les tests du service ne vérifient pas le transport HTTP réel ni la validation des jetons Firebase Authentication ou App Check. Voir `functions/README.md` pour le périmètre, les commandes locales et les limites.

### Construire et prévisualiser

Une variante explicite utilisant les modules du CDN officiel Firebase permet de construire les fichiers statiques sans installer les dépendances npm :

```sh
node build-pages.js --cdn
node preview-pages.js --cdn
```

La prévisualisation écoute sur `http://127.0.0.1:4173/ANIMAL-CARDS/`. Elle doit rester en cours d’exécution pendant la consultation ; son arrêt rend cette adresse inaccessible. Le dossier produit est `dist-cdn/`. Les chemins relatifs sont prévus pour ce sous-chemin de dépôt. Les modules Firebase sont chargés depuis Internet : cette variante n’est pas une version autonome hors ligne.

Les commandes équivalentes sont `npm run build:pages:cdn` et `npm run preview:pages:cdn`. La construction regroupée `npm run build:pages` utilise Firebase et `esbuild-wasm` installés localement et produit `dist/`.

L’installation locale des dépendances n’est pas confirmée : malgré un code de sortie nul de certaines commandes npm, les fichiers attendus de Firebase et d’`esbuild-wasm` étaient absents. La construction regroupée a donc échoué avec `ERR_MODULE_NOT_FOUND`. La réussite de la variante CDN ne valide ni cette installation ni la construction regroupée.

Les sorties `dist*` connues et les rapports `.frst/` sont exclus de Git. Les constructions utilisant `--emulators` sont réservées aux tests locaux et ne doivent pas être publiées.

### Vérifications reproductibles

```sh
npm run check:pages
npm run test:pages
npm run test:pages:browser
npm test
```

Le test navigateur nécessite Playwright et son navigateur Chromium installé. Il démarre sa propre prévisualisation, puis la ferme. Il ne crée aucun compte Firebase et n’effectue aucune transaction de jeu.

Vérifications effectuées le 4 novembre 2026 :

- **13 tests du service serveur réussis sur un émulateur Firestore réel** : paramètres stricts, revenus à l’heure serveur, boosters privés, ventes, échanges, enchères, achats concurrents, conservation des soldes et des cartes, plafonds et rejeu sans doublon. Le rapport `.frst/functions-test-result.json` indique `firestoreTransactionsVerified: true`, mais `callableHttpVerified: false` et `productionVerified: false`. L’arrêt de l’émulateur est confirmé.
- **9 groupes de contrôles des règles réussis** : profils et reçus cloisonnés, marché authentifié limité à 40 résultats, écritures clientes refusées et tirages privés inaccessibles même à leur acheteur. Le rapport `.frst/firestore-rules-test-result.json` vérifie le socle fermé, pas des règles autorisant les écritures du jeu : celles-ci passent par le serveur.
- **11 tests du suivi local réussis**, avec transport simulé : réponse perdue, reprise avec le même identifiant, erreurs ambiguës, stockage indisponible et séparation des comptes. Rapport : `.frst/pages-gateway-test-result.json`. Ces tests ne valident ni le SDK Firebase ni le transport HTTP réel.
- **15 tests du modèle local et 18 tests du serveur SQLite réussis** lors de la nouvelle exécution. Le modèle utilise des tirages déterministes pour ses tests ; les boosters du service serveur utilisent un tirage privé distinct.
- **11 contrôles navigateur réussis** sur la version CDN : catalogue, recherche, raretés, dialogues, accès visiteur et absence de débordement horizontal aux largeurs 320, 360, 390, 414, 768, 1024 et 1440 pixels. Le rapport `.frst/pages-browser-test-result.json` indique `status: "passed"` et `checkCount: 11` ; ses champs `firebaseTransactionsVerified` et `firestoreRulesVerified` restent à `false`, car ce test ne vérifie pas ces services.
- Construction CDN et contrôles de syntaxe réussis. Les illustrations sont des emoji, pas des photographies téléchargées.

Les commandes supplémentaires sont `npm run build:functions`, `npm run check:functions`, `npm run test:functions`, `npm run test:rules` et `npm run test:pages:gateway`. Les prérequis Windows des tests sur émulateur sont détaillés dans `functions/README.md`. Vérifier les rapports finaux, le nombre de contrôles et l’arrêt des processus, pas seulement le code de sortie. Aucun vérificateur ESLint ou TypeScript n’est configuré.

### Conditions restant à remplir avant publication du jeu

- Intégrer et configurer App Check côté navigateur avant d’utiliser la fonction qui l’impose hors émulateur. Ne pas supprimer cette protection ni ouvrir les écritures Firestore pour contourner un refus.
- Tester le parcours connecté de bout en bout : transport callable HTTP, véritables validations des jetons Authentication et App Check, reconnexion, coupure réseau et reprise depuis l’interface. Les tests locaux du service ne remplacent pas ces vérifications.
- Vérifier la configuration Authentication, les domaines autorisés, les règles et les index dans un environnement cible expressément autorisé. Aucun déploiement ni activation de facturation n’a été effectué.
- Valider le runtime Node.js 22 déclaré pour les fonctions : les tests locaux ont été exécutés sous Node.js 24.19.0. L’installation des SDK serveur a été vérifiée, mais pas la construction regroupée du navigateur.
- Préparer la supervision, les limites d’usage, la gestion des coûts, la sauvegarde et une procédure de reprise des transactions bloquées. Les avertissements de dépendances et de détection de métadonnées observés pendant les tests sont documentés dans `functions/README.md`.

Le marché affiche les propositions réellement reçues, sans joueurs artificiels. Dans cette version statique, une enchère expirée nécessite une action de clôture en ligne ; aucun traitement serveur automatique n’est fourni. Aucun module Google Analytics n’est ajouté par cette interface.
