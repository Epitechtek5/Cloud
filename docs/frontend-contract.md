# Contrat front / services serverless

> **Statut : proposition** à valider avec l'équipe `serverless`. Elle décrit ce dont le front a besoin ; tout ce qui
> est marqué **OUVERT** est à trancher. Si le modèle change, seul l'adaptateur GCP du front (`src/backend/`) change,
> l'UI reste intacte : elle ne dépend que de trois interfaces (`src/contract.ts`).

Le navigateur ne parle qu'à trois choses, toutes serverless : l'**API Gateway** (HTTPS, authentifiée), **Firestore**
(lecture seule, temps réel) et la **distribution des tuiles** (rasters). Il n'écrit jamais dans le stockage.

| Interface du front | Rôle | Section |
|---|---|---|
| `Api` | dessiner, inspecter un pixel | 1 |
| `TileSource` | image initiale d'une tuile 256x256 | 2 |
| `RealtimeChannel` | deltas de pixels, pause, quota, rejets | 3 |

Grille : `100 000 x 100 000` pixels (coordonnées `0..99999`), tuiles de `256 x 256` (391 x 391 tuiles). Couleur : entier `0xRRGGBB`.

## 1. HTTP via l'API Gateway (`Api`)

> **Gateway (#60)** : `apiBase` est l'URL de l'API Gateway (`infra/serverless/README.md`, « API Gateway »). Elle vérifie le JWT
> (`401` sinon) puis appelle la fonction avec son propre jeton ; la fonction lit l'utilisateur dans `X-Apigateway-Api-Userinfo`
> (claims en JSON base64url, `sub` = id Discord). `POST /pixels` est servi par `draw-proxy` et `GET /pixels/{x}/{y}` par
> `pixel-reader` (#66, `infra/serverless/pixels_api.tf`). Le CORS est répondu par chaque fonction (la gateway ne fait que transmettre `OPTIONS`).
> Pas de limitation à la gateway (les quotas exigent une clé d'API par projet, inutilisable pour des utilisateurs anonymes) :
> le rate limit métier est appliqué par le worker et revient en temps réel (section 3), pas en `429`.

Toutes les routes : `Authorization: Bearer <jwt>` (émis par `POST /auth/discord`, voir
[discord-activity.md](discord-activity.md)) et `X-Correlation-Id: <uuid>` (à propager dans les logs, l'événement et les traces).

### `POST /pixels` : dessiner (proxy, asynchrone)

```json
{ "batchId": "uuid", "pixels": [{ "x": 10, "y": 20, "color": 16711680 }] }
```

- Le proxy valide : JWT, `0 <= x,y < 100000`, `0 <= color <= 0xFFFFFF`, 1 à **256** pixels, `batchId` présent.
- Il publie **un événement** `pixel.draw` (utilisateur = `sub` du JWT, `batchId`, `correlationId`) et répond `202 { "batchId" }`
  sans attendre. Aucun travail lourd, aucune écriture de grille.
- `400 { "error": "invalid_request", "details": ["pixels[3].x must be between 0 and 99999", ...] }` si invalide (chemins seulement,
  jamais les valeurs), `401` si JWT absent ou expiré (refusé par la gateway, et par la fonction si l'utilisateur transmis manque),
  `503` si le broker est indisponible. Pas de `429` : voir l'encadré plus haut.
- `batchId` est la clé d'**idempotence** : le worker ignore un lot déjà traité (le broker peut livrer deux fois).
- Le rate limit métier (20 px/min par défaut, surcharge `/admin ratelimit`), la pause et la validation fine sont faits **par le
  worker**, pas par le proxy. Le résultat revient au front par le temps réel (section 3).

### `GET /pixels/{x}/{y}` : inspecter un pixel

`200 { "x", "y", "color", "author": "<id Discord>", "authorName": "alice", "ts": <epoch ms> }` ou `404` si jamais peint
(ou effacé par `/admin clear`), `400` hors de la grille.
Lecture seule, sans passer par le broker (aucun effet de bord).

### `POST /auth/discord`

Voir [discord-activity.md](discord-activity.md). **Ajout proposé** à la réponse : `firebaseToken` (custom token Firebase,
`uid` = id Discord), nécessaire aux listeners par utilisateur de la section 3. La fonction a besoin de
`roles/iam.serviceAccountTokenCreator` sur son propre compte de service pour le signer.

## 2. Tuiles : image initiale (`TileSource`)

Pour ne pas relire des milliers de documents, chaque tuile a un **raster** régénéré par un worker (snapshot périodique, cf. C06 §4.3) :

- `GET /tiles/{tx}/{ty}.png` : PNG 256x256, **alpha 0** pour les pixels jamais peints. `404` si la tuile est vide.
- **Version** = `t` du pixel le plus récent inclus dans le raster (epoch ms), lue **dans le PNG** : chunk `tEXt` de clé
  `Tile-Version` (`0` sur un 404). Aucun en-tête n'est nécessaire, donc aucune fonction devant le bucket.
- `Cache-Control: public, max-age=60`, posé sur chaque objet par le renderer : la fraîcheur vient des deltas (section 3), pas du cache.
- Le bucket qui contient les rasters reste **privé** (exigence du sujet) : le load balancer du front le lit par un **backend bucket**,
  comme les fichiers de l'app (même origine, donc pas de CORS ; question A, tranchée en section 6).

Ce que fait le backend (#68, `app/functions/src/tiles`, [functions.md](functions.md)) :

- **Version = plancher.** La version est le `t` du pixel le plus récent du raster, **arrondi à la milliseconde inférieure**.
  Le front redemande `t > version` : un pixel de la même milliseconde revient en double (la même couleur est réappliquée,
  sans effet). Arrondir vers le haut perdrait les pixels de la fin de la milliseconde. La version est écrite dans le PNG
  lui-même (chunk `tEXt` `Tile-Version`), donc elle correspond toujours aux octets servis, même pendant un nouveau rendu.
- **Après `/admin clear`**, le renderer supprime les rasters rendus avant l'effacement (`version <= session/state.clearedAt`) et
  repart d'une tuile vide. Le CDN peut encore servir une copie pendant son `max-age` : c'est le **front** qui l'ignore
  (`version <= clearedAt`) et qui s'abonne depuis `since = max(version, clearedAt)`, sinon il relirait les pixels d'avant
  l'effacement, toujours stockés (section 3, `session/state`).
- **Fraîcheur.** Un pixel dessiné apparaît dans son raster en 1 à 3 s ; une rafale de pinceau est regroupée (au plus un rendu par
  tuile et par 1,5 s). Le `404` d'un objet absent ne porte pas le `Cache-Control` public des rasters : le CDN ne devrait pas le
  garder (à vérifier au déploiement, `curl -I` deux fois de suite) ; au pire une tuile neuve reste vide côté raster quelques
  secondes, et ses pixels arrivent de toute façon par les deltas.

## 3. Temps réel : Firestore en lecture seule (`RealtimeChannel`)

Le navigateur s'abonne avec le SDK Firestore ; les écritures sont **refusées par les règles** (seuls les workers écrivent, via IAM).
Authentification : `signInWithCustomToken(firebaseToken)`.

### Pixels : `pixels/{x}_{y}`

```
{ x, y, tile: "tx_ty", c: 16711680, a: "<id Discord>", an: "alice", t: <Timestamp serveur> }
```

Un document par pixel peint (pas de document « tuile » géant : pas de contention sur les tuiles chaudes, pas de limite de 1 Mio).
Index composite `(tile ASC, t ASC)`, créé en Terraform (`google_firestore_index`, `infra/serverless/firestore.tf`). Le raisonnement
complet (découpage, deltas, rasters, cache) est dans [data-model.md](data-model.md).

Pour chaque tuile visible, le front :

1. télécharge le raster et lit sa version `v` (chunk `Tile-Version` du PNG) ;
2. ouvre `pixels.where("tile","==","tx_ty").where("t",">", v).orderBy("t").limit(65536)`.

La **limite est obligatoire** : les règles refusent toute requête sur `pixels` sans `limit` ou avec plus de 65 536 (la taille
d'une tuile, donc jamais atteinte par une requête de tuile). Elle plafonne ce qu'une requête abusive peut lire et facturer.

Le premier snapshot contient seulement ce qui est plus récent que le raster, puis chaque changement arrive en delta : **pas de
polling, aucun pixel perdu entre le raster et l'abonnement**. L'effacement (`/admin clear`) vide toute la grille : ce n'est **pas** un delta par pixel
(10^10 pixels), mais un signal (`pixel.processed` avec `cleared: true`) ; le front oublie ses deltas et recharge les rasters.

> Conséquence : le front s'abonne **après** avoir chargé le raster. C'est fait dans le front et le mock :
> `TileSource.loadTile` renvoie `{ rgba, version }` (`version` lue dans le PNG, `0` pour une tuile vide) et
> `RealtimeChannel.subscribeTile(tx, ty, cb, { since: version })` ne livre que les pixels `t > since`, puis les changements en direct.
> L'adaptateur GCP devra respecter cette sémantique (`where("t", ">", since)`).

### État global : `session/state`

`{ paused: boolean, clearedAt, epoch, updatedAt }`, écrit par le worker de commandes (`/admin pause|resume|clear`). Le front
désactive les outils quand `paused`. Quand `clearedAt` change (`/admin clear`), il oublie ses deltas et recharge les rasters ;
un pixel dont `t <= clearedAt` est effacé ([data-model.md](data-model.md) §3, « Effacement de la grille »).

### Par utilisateur : `users/{uid}` et `userEvents/{id}`

- `users/{uid}` : `{ limit, used, windowStart }`, mis à jour par le worker à chaque lot ; le front affiche le quota restant.
- `userEvents/{id}` : `{ uid, type: "rejected", reason: "rate_limited"|"paused"|"invalid", batchId, pixels: [...], t, expireAt }`, écrit par le
  worker pour les pixels refusés ; le front les écoute avec `where("uid","==",me).where("t",">", ouvertureDeLaPage)` (index composite
  `(uid, t)`) et retire les pixels optimistes concernés. Politique **TTL** sur `expireAt` (le worker met `t + 1 h`) pour limiter le stockage.

### Côté workers uniquement : `processedBatches/{batchId}`

`{ expireAt }`, créé dans la transaction qui applique un lot ; s'il existe déjà, le lot est ignoré (idempotence, Pub/Sub livre au
moins une fois). TTL sur `expireAt`, au-delà de la rétention Pub/Sub (7 jours). Invisible pour le navigateur.

### Règles de sécurité

Déployées par Terraform depuis [`infra/serverless/firestore.rules`](../infra/serverless/firestore.rules), testées dans l'émulateur
(`infra/serverless/tests/firestore-rules`, CI `ci-firestore-rules`). Résumé :

- toute écriture est refusée, partout ;
- « connecté » = custom token de `POST /auth/discord` (`sign_in_provider == "custom"`) ; les autres méthodes Firebase sont refusées ;
- `pixels` : `get` si connecté, `list` si connecté **et** `limit <= 65536` ;
- `session/state` : lecture si connecté (seul ce document) ;
- `users/{uid}` et `userEvents` : uniquement ses propres documents (la requête doit filtrer sur `uid == moi`) ;
- tout le reste (`processedBatches`, ...) : refusé.

## 4. Aperçu / mini-map (hors périmètre pour l'instant)

À 100 000 px de côté, le front ne montre que ~1 % de la largeur au zoom minimum (0,5x). Proposition : `GET /overview.png`
(1000x1000, 1 pixel = 100x100 de grille, couleur moyenne) régénéré par un worker, avec `X-Overview-Version`. Il ne sera **pas**
temps réel au pixel près (agrégat) ; à valider que c'est acceptable pour le critère « l'affichage est toujours à jour ».

## 5. Budget et limites à connaître

- Au zoom minimum le front ouvre ~100-150 tuiles : autant de listeners et de requêtes de rasters (mis en cache 60 s).
- Chaque delta coûte une lecture par listener concerné. Une charge de test (brush) multiplie les écritures Firestore : surveiller
  le quota et le budget.
- Le worker doit écrire `t` côté serveur (`serverTimestamp`) pour un ordre cohérent entre instances.

## 6. Questions ouvertes (à trancher avec l'équipe `serverless`)

- **A. Distribuer les rasters avec un bucket privé et un cache efficace.** Options étudiées : (1) une fonction « tile-reader » derrière la gateway
  qui lit GCS (simple, mais la gateway GCP ne met pas en cache) ; (2) la même fonction derrière le CDN/hébergement du front avec
  `Cache-Control` (même origine donc pas de CORS, et les mappings Discord restent simples) ; (3) URLs signées courtes
  (`GET /tiles/{tx}/{ty}/url`, un aller-retour de plus). Recommandation initiale : (2), remplacée par un backend bucket (ci-dessous).
  **DÉCISION (#68, revue de sécurité) : ni gateway ni fonction, un backend bucket.** La route `/tiles/*` du load balancer du
  front (`local.frontend_tiles_backend`, `infra/serverless/frontend.tf`) pointe vers un backend bucket avec Cloud CDN
  (`USE_ORIGIN_HEADERS`) sur le bucket privé `tiles` (`infra/serverless/tiles.tf`), lu par l'agent de service du load balancer
  (`objectViewer` sur ce bucket seulement), exactement comme les fichiers de l'app. Raisons : aucune fonction n'est joignable depuis
  internet (pas de `allUsers`, rien à saturer), le CDN absorbe le trafic (100 à 150 tuiles par page), même origine (pas de CORS,
  mappings Discord simples), et le sujet autorise le load balancer pour les fichiers statiques, ce que sont les rasters. Ce qu'une
  fonction aurait apporté est repris autrement : la version est dans le PNG (`tEXt`), le `404` est natif pour un objet absent, le
  `Cache-Control` est une métadonnée d'objet, et le front ignore un raster antérieur au dernier clear. Alternatives écartées :
  (1) la gateway (pas de cache, JWT exigé, un appel de fonction par tuile) ; (2) une fonction `tile-reader` derrière le CDN
  (essayée dans #68 : `allUsers` en `run.invoker` protégé par l'ingress seulement, accès Firestore exposé) ; (3) URLs signées (un
  aller-retour de plus par tuile). `gateway_tiles_route` reste `false`.
- **B. Hébergement du front.** `deploy-env.yml` passe `dist/` à Terraform (`app_artifact_dir`) et attend un output `app_url`.
  Qui génère `/config.json` (`env`, `apiBase`, `discordClientId` de l'environnement, config Firebase) à côté de `dist/` ?
  **Proposé par #70 (provisoire, à valider)** : la stack `infra/serverless` (Terraform) écrit `config.json` à partir des
  tfvars de l'environnement, à côté du même `dist/` promu de dev à prd. Hébergement : bucket privé derrière un load
  balancer HTTPS externe global avec Cloud CDN ; `app_url` est l'URL du front. Sans nom de domaine, l'hôte est
  `<ip>.sslip.io` (voir `infra/serverless/README.md`, « Frontend hosting »). `apiBase` reste vide jusqu'à la gateway (#60).
- **C. Granularité des tuiles Firestore et fréquence de régénération des rasters.** **DÉCISION PROVISOIRE (#59)**, à valider avec
  Quentin : tuiles de **256x256** ; rasters régénérés **par événement, avec coalescence par tuile** (un seul rendu en cours par tuile,
  aucun rendu pour une tuile calme). **Réalisé dans #68** (un leader par tuile, au plus un rendu par tuile toutes les 1,5 s, rendu
  incrémental : ancien raster + pixels plus récents). Détail et alternatives (512x512, Cloud Scheduler périodique) : [data-model.md](data-model.md) §2 et §4.
- **D. Mini-map** : acceptable qu'elle soit approximative ? **Non livrée dans #68** (optionnelle). Piste simple si l'équipe la veut :
  1 pixel d'aperçu = 128x128 de la grille (782x782 pour toute la grille, soit exactement 2x2 pixels par tuile), la couleur du
  dernier pixel peint du bloc ; chaque rendu de tuile met à jour son bloc de 2x2 dans l'objet `overview.png` (écriture conditionnelle sur la
  génération, avec reprise en cas de conflit). Elle n'est pas faite car 391 x 391 tuiles écrivent le même objet : il faudrait
  regrouper les rendus (Cloud Scheduler) plutôt que d'écrire à chaque tuile.
- **E. Firestore dans l'iframe Discord** : à valider dans une vraie Activity (voir `discord-activity.md` §4).
