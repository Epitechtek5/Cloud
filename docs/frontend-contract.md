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

Toutes les routes : `Authorization: Bearer <jwt>` (émis par `POST /auth/discord`, voir
[discord-activity.md](discord-activity.md)) et `X-Correlation-Id: <uuid>` (à propager dans les logs, l'événement et les traces).

### `POST /pixels` : dessiner (proxy, asynchrone)

```json
{ "batchId": "uuid", "pixels": [{ "x": 10, "y": 20, "color": 16711680 }] }
```

- Le proxy valide : JWT, `0 <= x,y < 100000`, `0 <= color <= 0xFFFFFF`, 1 à **256** pixels, `batchId` présent.
- Il publie **un événement** `pixel.draw` (utilisateur = `sub` du JWT, `batchId`, `correlationId`) et répond `202 { "batchId" }`
  sans attendre. Aucun travail lourd, aucune écriture de grille.
- `400` si invalide, `401` si JWT absent ou expiré, `429` si la gateway throttle.
- `batchId` est la clé d'**idempotence** : le worker ignore un lot déjà traité (le broker peut livrer deux fois).
- Le rate limit métier (20 px/min par défaut, surcharge `/admin ratelimit`), la pause et la validation fine sont faits **par le
  worker**, pas par le proxy. Le résultat revient au front par le temps réel (section 3).

### `GET /pixels/{x}/{y}` : inspecter un pixel

`200 { "x", "y", "color", "author": "<id Discord>", "authorName": "alice", "ts": <epoch ms> }` ou `404` si jamais peint.
Lecture seule, sans passer par le broker (aucun effet de bord).

### `POST /auth/discord`

Voir [discord-activity.md](discord-activity.md). **Ajout proposé** à la réponse : `firebaseToken` (custom token Firebase,
`uid` = id Discord), nécessaire aux listeners par utilisateur de la section 3. La fonction a besoin de
`roles/iam.serviceAccountTokenCreator` sur son propre compte de service pour le signer.

## 2. Tuiles : image initiale (`TileSource`)

Pour ne pas relire des milliers de documents, chaque tuile a un **raster** régénéré par un worker (snapshot périodique, cf. C06 §4.3) :

- `GET /tiles/{tx}/{ty}.png` : PNG 256x256, **alpha 0** pour les pixels jamais peints. `404` si la tuile est vide.
- En-tête `X-Tile-Version: <epoch ms>` = `t` du pixel le plus récent inclus dans le raster (`0` si 404). Il doit être exposé en CORS
  (`Access-Control-Expose-Headers`) si l'origine diffère de celle de l'app.
- `Cache-Control: public, max-age=60` : la fraîcheur vient des deltas (section 3), pas du cache.
- Le bucket qui contient les rasters reste **privé** (exigence du sujet) ; voir la question ouverte A.

## 3. Temps réel : Firestore en lecture seule (`RealtimeChannel`)

Le navigateur s'abonne avec le SDK Firestore ; les écritures sont **refusées par les règles** (seuls les workers écrivent, via IAM).
Authentification : `signInWithCustomToken(firebaseToken)`.

### Pixels : `pixels/{x}_{y}`

```
{ x, y, tile: "tx_ty", c: 16711680, a: "<id Discord>", an: "alice", t: <Timestamp serveur> }
```

Un document par pixel peint (pas de document « tuile » géant : pas de contention sur les tuiles chaudes, pas de limite de 1 Mio).
Index composite `(tile ASC, t ASC)`, à créer en Terraform (`google_firestore_index`).

Pour chaque tuile visible, le front :

1. télécharge le raster et lit `X-Tile-Version` = `v` ;
2. ouvre `pixels.where("tile","==","tx_ty").where("t",">", v).orderBy("t")`.

Le premier snapshot contient seulement ce qui est plus récent que le raster, puis chaque changement arrive en delta : **pas de
polling, aucun pixel perdu entre le raster et l'abonnement**. L'effacement (`/admin clear`) est un delta avec `c = -1`.

> Conséquence : le front doit s'abonner **après** avoir chargé le raster (le mock actuel s'abonne avant). Le changement est
> prévu dans la PR de l'adaptateur (`subscribeTile(tx, ty, cb, { since })`).

### État global : `session/state`

`{ paused: boolean, updatedAt }`, écrit par le worker `/admin pause|resume`. Le front désactive les outils quand `paused`.

### Par utilisateur : `users/{uid}` et `userEvents/{id}`

- `users/{uid}` : `{ limit, used, windowStart }`, mis à jour par le worker à chaque lot ; le front affiche le quota restant.
- `userEvents/{id}` : `{ uid, type: "rejected", reason: "rate_limited"|"paused"|"invalid", batchId, pixels: [...], t }`, écrit par le
  worker pour les pixels refusés ; le front les écoute avec `where("uid","==",me).where("t",">", ouvertureDeLaPage)` et retire les
  pixels optimistes concernés. Politique **TTL** (ex. 1 h) pour limiter le stockage.

### Règles de sécurité (esquisse)

```
match /pixels/{id}      { allow read: if request.auth != null; allow write: if false; }
match /session/{id}     { allow read: if request.auth != null; allow write: if false; }
match /users/{uid}      { allow read: if request.auth.uid == uid; allow write: if false; }
match /userEvents/{id}  { allow read: if request.auth.uid == resource.data.uid; allow write: if false; }
```

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

- **A. Distribuer les rasters avec un bucket privé et un cache efficace.** Options : (1) une fonction « tile-reader » derrière la gateway
  qui lit GCS (simple, mais la gateway GCP ne met pas en cache) ; (2) la même fonction derrière le CDN/hébergement du front avec
  `Cache-Control` (même origine donc pas de CORS, et les mappings Discord restent simples) ; (3) URLs signées courtes
  (`GET /tiles/{tx}/{ty}/url`, un aller-retour de plus). Recommandation : **(2)**.
- **B. Hébergement du front.** `deploy-env.yml` passe `dist/` à Terraform (`app_artifact_dir`) et attend un output `app_url`.
  Qui génère `/config.json` (`env`, `apiBase`, `discordClientId` de l'environnement, config Firebase) à côté de `dist/` ?
- **C. Granularité des tuiles Firestore** (`tile` = 256x256 ici) et fréquence de régénération des rasters (par événement avec debounce, ou
  périodique).
- **D. Mini-map** : acceptable qu'elle soit approximative ?
- **E. Firestore dans l'iframe Discord** : à valider dans une vraie Activity (voir `discord-activity.md` §4).
