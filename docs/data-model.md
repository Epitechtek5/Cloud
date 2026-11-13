# Modèle de données : Firestore et buckets

> Infra : `infra/serverless/firestore.tf`, `firestore.rules`, `storage.tf` (issue #59). Contrat côté navigateur :
> [frontend-contract.md](frontend-contract.md). Sujet : 3.1, 3.3, C06 §4, C07 §3.4 et §5.

La grille fait `100 000 x 100 000` pixels (le sujet en exige au moins `10 000 x 10 000`). Ce document explique comment on la
stocke sans « document géant », comment le navigateur la charge vite et reste à jour sans polling, et qui a le droit de
lire ou d'écrire quoi.

## 1. Où vit chaque donnée

| Donnée | Stockage | Écrit par | Lu par |
|---|---|---|---|
| État courant des pixels | Firestore `pixels/{x}_{y}` | worker de dessin (IAM) | navigateur (règles), inspection, rendu des tuiles |
| Pause globale | Firestore `session/state` | worker admin (IAM) | navigateur, workers |
| Quota d'un utilisateur | Firestore `users/{uid}` | worker de dessin (IAM) | son propriétaire seulement |
| Pixels refusés | Firestore `userEvents/{id}` (TTL) | worker de dessin (IAM) | son propriétaire seulement |
| Lots déjà traités | Firestore `processedBatches/{batchId}` (TTL) | worker de dessin (IAM) | workers uniquement |
| Raster de chaque tuile | bucket privé `<projet>-tiles`, `{tx}/{ty}.png` | worker de rendu (IAM) | fonction de lecture des tuiles (IAM) |
| Images `/snapshot` | bucket privé `<projet>-snapshots` | snapshot-worker (IAM) | notifier, qui signe une URL courte |

Règle simple, celle de C06 §4.4 : **état structuré dans Firestore, fichiers dans un bucket**. Un bucket ne sert jamais de
base de données (piège C07 §5), et Firestore ne stocke pas d'images.

## 2. Découpage (chunking) : un document par pixel peint, groupé par tuile

```
pixels/{x}_{y} = { x, y, tile: "tx_ty", c: 0xRRGGBB, a: "<id Discord>", an: "alice", t: <timestamp serveur> }
```

- **Un document par pixel peint**, jamais un document par grille ni par tuile. Une grille vide ne coûte rien ; on ne
  stocke que ce qui a été dessiné (C06 §4.3 : « store only painted pixels »).
- **Pourquoi pas un document par tuile ?** Une tuile de 256x256 dans un seul document dépasserait vite la limite de 1 Mio
  d'un document (65 536 pixels avec auteur et date), et deux dessins sur la même tuile se disputeraient le même document
  (Firestore tient environ une écriture par seconde et par document). Avec un document par pixel, deux utilisateurs ne se
  gênent que s'ils peignent **le même pixel**.
- **Le champ `tile`** (`tx_ty`, avec `tx = floor(x / 256)`) regroupe les pixels par tuile sans changer la clé. Il sert à
  l'index composite `(tile, t)` ci-dessous et au rendu des rasters.
- **Clé `{x}_{y}`** : écrire un pixel est un `set` sur une clé connue, l'inspection (`GET /pixels/{x}/{y}`) est une lecture
  directe, sans requête.
- **Auteur et date** (sujet 3.3) : `a` (id Discord), `an` (nom affiché, copié à l'écriture pour ne pas relire un profil) et
  `t` (horodatage **serveur**, `serverTimestamp()`, identique quelle que soit l'instance du worker).

### Décision C : tuiles de 256x256 (DÉCISION PROVISOIRE)

256 est un compromis : `391 x 391` tuiles pour toute la grille, une centaine à l'écran au zoom minimum, un PNG de 256x256
pèse quelques Kio. Plus petit (64x64) multiplierait les listeners et les requêtes de rasters par 16 ; plus grand (1024)
ferait télécharger beaucoup de pixels hors écran. C'est la taille par défaut des cartes web, que le front utilise déjà.
Alternative : 512x512 (4 fois moins de listeners, rasters plus lourds). À valider avec Quentin (workers).

## 3. Deltas : le navigateur ne reçoit que les pixels qui changent

Pour chaque tuile visible, le front :

1. télécharge le raster et lit sa version `v` (`X-Tile-Version`, le `t` du pixel le plus récent qu'il contient) ;
2. ouvre un listener Firestore `pixels where tile == "tx_ty" and t > v orderBy t limit 65536`.

Le premier résultat ne contient que les pixels plus récents que le raster, puis chaque écriture arrive en **delta** (temps
réel, sans polling, C07 §3.3). Aucun pixel n'est perdu entre le raster et l'abonnement, puisque l'abonnement part de la
version exacte du raster.

- **Index composite `(tile ASC, t ASC)`** : une égalité sur `tile` plus une inégalité sur `t` l'exige. Il est créé par
  Terraform (`google_firestore_index`), pas à la main depuis le lien d'erreur de la console.
- **`limit(65536)`** : une tuile contient au plus `256 x 256 = 65 536` pixels, donc la requête d'une tuile n'atteint
  jamais cette limite. Les règles refusent toute requête sans limite ou au-delà : quelqu'un qui interrogerait toute la
  collection ne pourrait pas lire (et nous faire payer) plus de 65 536 documents par requête.
- **Pas d'index simple sur `pixels.t`** : `t` ne fait que croître. Un index sur une valeur croissante envoie toutes les
  écritures au même endroit, ce qui plafonne la collection vers 500 écritures/s. Aucune requête n'utilise `t` seul,
  l'index est donc désactivé (`google_firestore_field`) ; l'index composite, lui, commence par `tile` et répartit la charge.
- **Effacement** (`/admin clear`) : un delta avec `c = -1`, pour que les navigateurs l'appliquent comme le reste.

## 4. Snapshots : raster par tuile + deltas, pour un chargement rapide

Relire des milliers de documents à chaque ouverture serait lent et cher. Chaque tuile a donc un **raster** PNG
(C06 §4.3 : « periodic snapshots plus edits since the last snapshot »), régénéré par un worker à partir de Firestore et
stocké dans le bucket `tiles`. Le raster porte sa version ; les deltas comblent l'écart.

### Fréquence de régénération (DÉCISION PROVISOIRE)

**Par événement, avec coalescence par tuile** plutôt qu'à intervalle fixe :

- le worker de dessin publie `tile.dirty` (Pub/Sub) pour chaque tuile touchée, seulement si elle n'était pas déjà marquée
  « à refaire » (transaction sur un petit document d'état de la tuile) ;
- le worker de rendu relit les pixels de la tuile, écrit le PNG avec sa version, puis enlève la marque, ou republie si
  d'autres pixels sont arrivés pendant le rendu.

Une tuile très active n'a ainsi qu'un rendu en cours à la fois, et une tuile calme n'est jamais refaite pour rien. Le
navigateur n'en dépend pas pour être à jour (il a les deltas) : la fraîcheur des rasters ne joue que sur le coût du
premier chargement. Un délai minimal entre deux rendus (vrai debounce) demanderait un envoi différé (Cloud Tasks) ;
alternative plus simple : Cloud Scheduler toutes les minutes qui publie `tiles.render` pour les tuiles marquées. À
valider avec Quentin, qui écrit ces workers.

`/snapshot` est un autre usage : une image horodatée de toute la grille, écrite dans le bucket `snapshots`. L'événement
« objet créé » du bucket est `snapshot.ready`, et le notifier renvoie une URL signée courte dans Discord (C07 §2).

## 5. Cache

- **Rasters** : `Cache-Control: public, max-age=60` servi par la fonction de lecture des tuiles, derrière le CDN du front
  (question A du contrat). Un raster un peu ancien n'est pas faux : les deltas `t > v` le complètent.
- **Navigateur** (proposition pour l'adaptateur GCP) : fermer les listeners des tuiles qui sortent de l'écran et garder
  leur image en mémoire ; à leur retour, repartir de la version déjà connue plutôt que du raster.
- **Firestore** : après une coupure courte (moins de 30 min), un listener reprend où il en était, et seuls les
  changements sont renvoyés et facturés.

## 6. Cohérence et idempotence

- **Dessins concurrents sur un même pixel** : dernier écrit gagne, avec l'ordre de `t` (horodatage serveur). Chaque
  pixel est son propre document, donc pas de verrou sur une tuile.
- **Quota** (`users/{uid}`) : lu et incrémenté dans une transaction (mode `PESSIMISTIC` de la base), pour que deux lots
  simultanés du même utilisateur ne dépassent pas sa limite.
- **Pub/Sub livre « au moins une fois »** : le worker crée `processedBatches/{batchId}` dans la même transaction que le
  reste ; si le document existe déjà, le lot a déjà été appliqué et il est ignoré.
- **TTL** : `processedBatches` et `userEvents` ont un champ `expireAt` (horodatage) que le worker remplit ; Firestore
  supprime le document une fois cette date passée (en général dans les 24 h). `processedBatches` doit vivre plus
  longtemps que la rétention Pub/Sub (7 jours au plus) ; `userEvents` environ une heure.

## 7. Qui peut lire et écrire

| | Navigateur (règles Firestore) | Workers et fonctions (IAM) |
|---|---|---|
| Écriture | **toujours refusée** | `roles/datastore.user` (niveau projet, déjà dans `DEPLOY_GRANTABLE_ROLES`) |
| `pixels` | lecture si connecté, requêtes avec `limit <= 65536` | lecture/écriture selon le rôle |
| `session/state` | lecture si connecté | |
| `users/{uid}`, `userEvents` | son propre document seulement | |
| `processedBatches`, autres | rien | |
| Buckets | rien (non publics, non liés à Firebase) | rôle **sur le bucket** seulement, par fonction |

- « Connecté » signifie un custom token émis par `POST /auth/discord` (`sign_in_provider == "custom"`). Une autre méthode
  Firebase (anonyme, e-mail) activée par erreur dans la console reste refusée.
- Les règles ne s'appliquent pas aux appels IAM : les workers ne sont limités que par leur rôle. Firestore n'a pas d'IAM
  par collection, d'où le rôle au niveau projet pour les workers.
- Buckets : `public_access_prevention = "enforced"` refuse toute liaison `allUsers` / `allAuthenticatedUsers`, et
  l'accès uniforme supprime les ACL par objet. Le navigateur n'y accède jamais directement, d'où l'absence de CORS.

Vérifications : `infra/serverless/tests/firestore-rules` (règles, émulateur, CI `ci-firestore-rules`) et, après un
déploiement, `scripts/check-private-access.sh <project_id>` (accès anonyme aux buckets et écriture anonyme dans Firestore
refusés).
