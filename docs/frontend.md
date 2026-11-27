# Frontend track: web app and Discord Activity

Subject 5.4 / 5.6, issue #82 (part of the documentation epic #78). This page explains how the front works and why it is
built this way. Its siblings: `infra.md` and `infra-security.md` (hosting platform, pipeline; infra track, issue #80, not merged yet), [`functions.md`](functions.md) (the
services the front talks to), [`frontend-security.md`](frontend-security.md) (what is public) and
[`open-source-frontend.md`](open-source-frontend.md) (every dependency, justified).

The exact messages exchanged with the services (routes, Firestore documents, rules) are specified once, in
[`frontend-contract.md`](frontend-contract.md): this page does not repeat them.

> **Status of the real backend.** The adapter that talks to the real services (`app/frontend/src/backend/gcp/`) is
> delivered by PR #139 (issue #71, part 2). Everything marked **(#139)** below is documented from that branch and is
> not on `dev` yet; until it is merged, only the mock backend works. See [What arrives with #139](#what-arrives-with-139).

## At a glance

| | |
| --- | --- |
| What | A 100 000 x 100 000 pixel canvas, live for every user, in a browser tab or inside a Discord Activity |
| Stack | Vite + TypeScript, rendering with the Canvas 2D API, no UI framework |
| Code | [`app/frontend`](../app/frontend), about 3 000 lines with their tests (12 test files, 84 tests on `dev`) |
| Runtime dependencies | `@discord/embedded-app-sdk` (loaded only inside Discord); `firebase` once #139 is merged |
| Hosting | Static files in a **private** bucket, behind an HTTPS load balancer and Cloud CDN (#70, [`infra/serverless/README.md`](../infra/serverless/README.md), "Frontend hosting") |
| Talks to | API Gateway (writes, pixel lookup, login), Firestore (read-only real time), tile rasters (first image of a tile) |
| Never does | Write to Firestore or a bucket, poll, store a secret, store a token on disk |

## How the browser talks to the cloud

```
                         ┌── GET /config.json, index.html, assets/* ──> LB + Cloud CDN -> private bucket
                         │
browser / Discord        ├── POST /auth/discord, POST /pixels, GET /pixels/{x}/{y} ──> API Gateway -> functions
Activity iframe ─────────┤        (Authorization: Bearer <our JWT>, X-Correlation-Id)
                         │
                         ├── GET /tiles/{tx}/{ty}.png  ──> same origin (CDN route, #68)  ──> raster of the tile
                         │
                         └── Firestore listeners (read only) ──> pixels, session/state, users/{me}, userEvents
                                 signed in with the Firebase custom token returned by the login (#139)
```

Writes only ever go through the gateway ([`functions.md`](functions.md): proxy, queue, worker). The browser sees the
result of a write the same way it sees everybody else's: through the Firestore listeners.

## Code map

| Path | Role |
| --- | --- |
| `src/contract.ts` | The three interfaces the UI depends on (`TileSource`, `RealtimeChannel`, `Api`, bundled as `Backend`) and the grid constants |
| `src/backend/` | `index.ts` picks the implementation; `mock.ts` is the in-browser fake; `gcp/` is the real adapter (#139) |
| `src/canvas/` | `geometry.ts` (viewport maths), `tileManager.ts` (which tiles are alive), `surface.ts` (one canvas per tile), `renderer.ts` (draws a frame), `controls.ts` (pan, zoom, touch), `brush.ts` (stroke interpolation) |
| `src/draw/drawController.ts` | Batches pixels, optimistic layer, rollback on rejection |
| `src/auth/` | `web.ts` (redirect, code + PKCE), `activity.ts` (Discord SDK), `exchange.ts` (`POST /auth/discord`), `mock.ts` |
| `src/platform/context.ts` | Web or Activity detection, URL mappings of the Activity |
| `src/runtimeConfig.ts` | Reads and validates `/config.json` |
| `src/ui/` | Toolbar, coordinates, pixel inspector, login and error screens |

Tests (`vitest`, Node environment) cover everything that is logic: viewport maths, the tile manager (raster then
subscription, eviction, retries), the draw controller, both login flows (state check, PKCE, expiry), the config parser and
the platform detection. They do not need a browser, because the browser parts are behind small interfaces
(`TileSurface`, `KeyValueStore`, `ActivitySdk`).

## The canvas

- **Grid and tiles.** The grid is `100 000 x 100 000` (`GRID_SIZE`), cut in tiles of `256 x 256` (`TILE_SIZE`), that is
  `391 x 391 = 152 881` tiles. The same constants are used by the services; the data model behind them is in
  [`data-model.md`](data-model.md).
- **Only the visible tiles exist.** `TileManager.setVisible` receives the tile range of the viewport plus a margin of one
  tile (`PREFETCH_MARGIN`). A tile entering the range is opened, a tile leaving it is evicted: its raster is dropped
  **and** its subscription is cancelled. Zooming out is capped at 0.5x (about 100 tiles on a large screen), because
  below that a screen would need thousands of listeners.
- **One canvas per tile.** Each tile has its own 256 x 256 canvas (`CanvasTileSurface`). A delta repaints one pixel on
  it; a frame only copies the visible tile canvases to the screen canvas (`drawImage`, smoothing off, edges snapped to
  whole pixels so neighbouring tiles leave no seam). Frames are requested with `requestAnimationFrame` only when something
  changed (`dirty` flag), so an idle canvas costs nothing.
- **Raster first, subscription second.** `TileManager.open` loads the raster, which carries a `version` (the time of its
  newest pixel), then subscribes with `since: version`. The channel delivers what the raster misses, then live changes.
  Nothing is lost between the two and the front buffers nothing.
- **Drawing.** Two tools: *Inspect* (click selects a pixel, `GET /pixels/{x}/{y}`) and *Brush* (size 1 to 32). A stroke is
  interpolated (Bresenham), deduplicated, grouped for about 100 ms and sent in batches of at most 256 pixels
  (`MAX_DRAW_BATCH`, the limit of the proxy) with a fresh `batchId`, the idempotency key of the worker. The pixel shows
  at once (optimistic layer); the real-time echo replaces it. A pixel rejected (quota, pause, invalid) or left without any
  answer for 15 s is removed with a message: the server stays authoritative.

## Runtime configuration: one build for every environment

`npm run build` produces **one** artefact (`dist/`). `deploy.yml` builds it once; `deploy-env.yml` hands the same files
to Terraform for `dev`, then for `prd`. Nothing specific to an environment is compiled in. The values that differ are in
`/config.json`, **written by the `infra/serverless` stack** next to the build from the tfvars of the environment
(`frontend.tf`, `frontend_runtime_config`) and read by `loadRuntimeConfig` before anything else:

| Key | Meaning | Public? |
| --- | --- | --- |
| `env` | `dev` or `prd` | yes |
| `apiBase` | URL of the API Gateway (or a same-origin path) | yes, the front calls it |
| `discordClientId` | Id of the Discord application of this environment (dev and prd have different ones) | yes, it is in every authorize URL |
| `firebase.apiKey`, `projectId`, `authDomain` | Firebase web config of the project | yes, see [`frontend-security.md`](frontend-security.md) |
| `tilesBase` (#139) | Base URL of the rasters, `/tiles` by default (same origin) | yes |

`parseRuntimeConfig` rejects a missing key, a non-numeric client id, or an `apiBase` that is not an `http(s)` URL without
query. A missing file is often answered with the CDN's HTML fallback, so a non-JSON answer gets its own error message.
The file is served with `Cache-Control: no-cache` and fetched with `cache: 'no-store'`: a deploy reaches the users at once.

`npm run dev` uses no config at all: the mock backend and a fake user. `BACKEND=gcp npm run dev` talks to the real
services with a `config.json` you serve yourself (see [`discord-activity.md`](discord-activity.md) section 3).

## Two ways to run: the `Backend` interface

The UI never imports a cloud SDK. It only knows `Backend = { tiles, realtime, api }`:

| Interface | Role | Mock (`npm run dev`) | GCP adapter (#139) |
| --- | --- | --- | --- |
| `TileSource` | PNG raster of a tile and its version | generates a tile from the mock's pixels | `GET {tilesBase}/{tx}/{ty}.png` and `X-Tile-Version` |
| `RealtimeChannel` | deltas of a tile, `session/state`, quota and rejections of the user | in-memory events, simulated other users (the only `setInterval` allowed) | Firestore `onSnapshot` listeners |
| `Api` | `draw(pixels, batchId)`, `pixelInfo(x, y)` | in-memory, 20 px/min by default | gateway calls with the JWT |

`backend/index.ts` selects with the build-time constant `__BACKEND__` (`mock` for `vite` in development, `gcp` for every
build). The test is a constant condition, so Vite removes the mock from the production bundle (tree shaking): what is
deployed contains no fake code. This is how the front was built and tested before the services existed.

## Discord Activity

The same code runs in a browser tab (`web`) and inside Discord (`activity`). `detectPlatform` returns `activity` only if
the page is in an iframe **and** the URL carries `frame_id`: a plain tab with `?frame_id=` stays in web mode instead of
waiting for a handshake that never comes.

- **Login.** Web: redirect to Discord with `state` and a PKCE challenge, the code comes back on the redirect URI and is
  exchanged by the `auth-discord` function (the client secret never reaches the browser). Activity: `sdk.authorize`
  then `sdk.authenticate`, no redirect. Both end with our own short-lived JWT kept **in memory only**.
  Full flow, Developer Portal settings and the contract of `POST /auth/discord`: [`discord-activity.md`](discord-activity.md).
- **URL mappings.** An Activity runs behind a CSP that only allows the Discord proxy (`<app_id>.discordsays.com`), so
  every host the front calls needs a mapping in the Developer Portal. `patchUrlMappings` of the SDK then rewrites
  `fetch`, `XMLHttpRequest` and `WebSocket` to the proxy. The list is in `src/platform/context.ts` (`activityMappings`,
  `FIREBASE_HOSTS`) and must stay identical to the portal.
- **`lateFetch`.** `patchUrlMappings` replaces `window.fetch`; a reference captured earlier would bypass the proxy. Every
  network call therefore goes through `lateFetch`, which looks `fetch` up at call time.
- **Lazy SDK.** The Discord SDK is a separate chunk (157 kB, 47 kB gzipped) loaded only in an Activity; a browser tab never
  downloads it.
- **Open point (question E).** Firestore real time inside the Activity iframe has not been tried in a real Activity.

## Hosting, auth and gateway: where each is documented

| Subject | Where | Front-side point |
| --- | --- | --- |
| Private bucket, load balancer, certificate, Cloud CDN, cache, `sslip.io` (#70) | [`infra/serverless/README.md`](../infra/serverless/README.md) "Frontend hosting"; infra track doc `infra.md` (#80) | The front is plain static files, `assets/*` immutable for a year, `index.html` and `config.json` revalidated, so a deploy needs no cache invalidation |
| Discord login and session JWT (#67) | [`discord-activity.md`](discord-activity.md) section 2; [`functions.md`](functions.md) | The front sends the code and the PKCE verifier, receives the JWT, never a Discord token it must keep |
| API Gateway (#60) | [`infra/serverless/README.md`](../infra/serverless/README.md) "API Gateway"; [`frontend-contract.md`](frontend-contract.md) section 1 | `Authorization: Bearer <JWT>` and `X-Correlation-Id` on every call; the gateway answers `401` itself |
| Firestore rules and documents | [`frontend-contract.md`](frontend-contract.md) section 3; [`data-model.md`](data-model.md) | The browser has read-only access, and only through queries the rules accept |

## What arrives with #139

PR #139 (issue #71, "GCP backend adapter") adds `src/backend/gcp/` and the `firebase` dependency. Nothing in the UI changes.

| File | Implements | How |
| --- | --- | --- |
| `index.ts` | `createGcpBackend` | `initializeApp(config.firebase)`, `signInWithCustomToken(session.firebaseToken)`, then assembles the three parts. Firestore is created with `experimentalAutoDetectLongPolling` as a safety net behind the Discord proxy |
| `api.ts` | `Api` | `POST /pixels` (only `202` is success), `GET /pixels/{x}/{y}` (`404` is "never painted"); validates coordinates before the call and the shape of the answer after |
| `tiles.ts` | `TileSource` | `GET {tilesBase}/{tx}/{ty}.png`; `404` is an empty tile (version 0); a `200` that is not a PNG or has no valid `X-Tile-Version` is an error and the tile is retried at the next move |
| `realtime.ts`, `firestoreStore.ts`, `mappers.ts` | `RealtimeChannel` | `pixels where tile == "tx_ty" and t > version orderBy t limit 65536`; `session/state`; `users/{uid}`; `userEvents where uid == me and t > page opening`. Only added or modified documents are deltas |

Details worth knowing: the quota is stored when the user draws, so once the 60 s window ends the front announces the
full quota with **one `setTimeout`** (not polling); `version` is rounded down to the millisecond, so a pixel may arrive
twice but never zero times; the browser clock only decides which rejections are "after the page opened". The code is
unit tested with a fake store; it was also run against the Firestore emulator with the real `firestore.rules`
(not committed, the front CI has no emulator).

Decisions of #139 that the team has to confirm: `tilesBase` optional with the default `/tiles` (option 2 of question A
of the contract), no `Authorization` header on tiles (public, cached by the CDN; to confirm with #68), and
`@grpc/grpc-js` forced to `^1.14.7` by `overrides` (see [`open-source-frontend.md`](open-source-frontend.md)).
The real login needs `auth_discord_firebase_custom_token` enabled in Terraform, otherwise the app shows an explicit error.

## Design choices to defend

Each choice says what was kept and what was rejected.

### Why Vite and TypeScript with no UI framework

The screen is one canvas and a few buttons; the hard part is rendering and state, not components. Vite gives a static
build (what a bucket can serve), a dev server and the test runner in one tool chain. TypeScript catches the shape
mismatches between the UI, the contract and the services at compile time. **Rejected:** React or Vue (a virtual DOM adds
nothing to a canvas and weighs more), a server-rendered app (needs a server, forbidden by the subject).

### Why Canvas 2D, one canvas per tile

100 000 x 100 000 is 10^10 pixels: nothing can be an element, and nothing can be fully in memory. Canvas 2D is available
everywhere (including the Discord client and phones), needs no shader code, and `drawImage` of a few hundred tile canvases
per frame is cheap. A per-tile canvas lets a delta repaint one pixel without touching anything else. **Rejected:**
WebGL (faster for millions of draws but more code, context loss handling and no need at this scale), one giant canvas
(would be 40 GB), DOM elements per pixel.

### Why 256 x 256 tiles and a grid of 391 x 391

One tile is 64 KiB of RGBA: small enough to download and decode in a few milliseconds, large enough that a screen needs
only a few. 256 is also the size the Firestore model uses (one query per tile, at most 65 536 documents, which is the
`limit` the rules enforce), see [`data-model.md`](data-model.md) sections 2 and 4. **Alternative still discussed by the team:**
512 x 512 tiles (open question C, provisional decision #59 keeps 256). The front only needs `TILE_SIZE` to change.

### Why raster first, then subscribe from its version

Reading the current state of a tile from Firestore would cost up to 65 536 reads **per tile per user**. Instead a worker
renders a PNG raster per tile (a cheap, cacheable file) and Firestore only carries what is newer than it. Subscribing
*after* loading the raster, with `since = raster version`, removes the race: the subscription starts from a known point,
so there is nothing to buffer, deduplicate by hand or lose. **Rejected:** subscribing first and loading the raster after
(needs a buffer and a merge), loading all pixels from Firestore (cost), polling the raster (forbidden, and stale).

### Why real time by listeners and never polling

The subject requires an always up to date display without polling. `setInterval` is **forbidden by ESLint**
(`no-restricted-globals` and `no-restricted-properties`); the only exception is the mock, which simulates other users.
Timers that remain are one-shot (`setTimeout` for debounce, acknowledgement timeout, quota window), none repeating a
request. **Rejected:** periodic refresh (latency, wasted reads), Server-Sent Events or WebSocket served by our own
function (more to run; kept as plan B behind `RealtimeChannel` if Firestore does not work in the Activity iframe).

### Why a `Backend` interface and a mock

The services were built in parallel by other people. A contract (`src/contract.ts`, specified in
[`frontend-contract.md`](frontend-contract.md)) let the whole UI, the drawing logic and the tests exist before any
service, and keeps the cloud SDK out of the UI. If the data model changes, only `src/backend/gcp/` changes.
**Rejected:** calling the services directly from the components (untestable without a cloud, every model change would
touch the UI).

### Why one build and a runtime `/config.json`

The subject asks for the same artefact in dev and prd (promotion, not rebuild). A build with the environment compiled in
would be a different artefact per environment. The environment-specific values are all public, so a file next to the
build is enough, and Terraform already knows them. **Rejected:** `VITE_*` variables at build time (one build per
environment, what is tested is not what is deployed); generating `config.json` in the workflow (the values live in
tfvars, a second source of truth).

### Why a private bucket behind a load balancer and CDN

It is the only option meeting at once "buckets never public", "no function reachable directly" and "everything deployed by
Terraform with the same artefact". Firebase Hosting cannot be fed files by Terraform and its rewrites to a function need
the function to be public; Cloud Run needs an image per release. Hosting details in
[`infra/serverless/README.md`](../infra/serverless/README.md). Cost: the load balancer is billed by the hour and
`sslip.io` stands in for a domain (documented trade-off in `infra-security.md` (#80) and
[`reproducibility.md`](reproducibility.md)).

### Why the JWT stays in memory

A token in `localStorage` is readable by any script of the page and survives the tab. In memory, it dies with the tab and
is out of reach of a stolen disk. The price: a reload is a logout in the browser (Discord remembers the consent, so one
click logs back in), and in an Activity the handshake is replayed. The only things written to `sessionStorage` are the
`state` and the PKCE verifier of a login in progress, deleted on return (also when Discord answers `?error=`).
**Rejected:** `localStorage` (persistent token), cookies (needs a server to set them, and third-party cookies are
blocked in an iframe).

### Why the browser never writes to Firestore

All writes go gateway -> proxy -> queue -> worker, so quota, pause, validation and idempotence are enforced in one place
that the user cannot bypass. Firestore rules refuse every write from a client, and only allow the reads the front makes.
**Rejected:** direct writes with security rules (rules cannot express the quota and the batch rules, and a modified client
could paint at will).

### Why the Discord SDK and the Firebase SDK are loaded on demand

A tab of the web version needs neither Discord's SDK nor, before login, Firebase's. Dynamic `import()` gives separate
chunks: the entry chunk is 29 kB (11 kB gzipped) and the Discord SDK (47 kB gzipped) only loads in an Activity; the Firebase
SDK of #139 is its own chunk loaded after the login. Faster first paint, and a failing real-time layer cannot prevent
the login screen from appearing.

## Known limits

- **Zoom out is capped at 0.5x.** A 100 000-wide grid shows about 1 % of its width at that scale. The mini-map
  (question D, section 4 of the contract) is not built; the "go to (x, y)" form teleports instead.
- **Rasters depend on #68** (question A, handled separately). Without them every tile starts from Firestore with
  `since = 0`: it works but costs reads.
- **`/admin clear` has no dedicated channel** to the front yet: the contract plans `clearedAt` on `session/state` and a
  reload of the rasters, the adapter of #139 does not implement it.
- **Firestore in the Discord iframe is untested** (question E).
- **The Discord SDK pulls a Zod version with a published advisory**, covered by a justified, dated exception
  ([`open-source-frontend.md`](open-source-frontend.md), [`ci/dependency-audit.md`](ci/dependency-audit.md)).

## Checks run by CI on a front change

`ci-frontend.yml`, only when `app/frontend/**` changes: `npm ci`, `eslint`, `tsc --noEmit`, `vitest`, `vite build` (job
`test`), and `npm audit --omit=dev --audit-level=high` with the exception mechanism of
[`ci/dependency-audit.md`](ci/dependency-audit.md) (job `audit`). `ci-security.yml` also scans the front with gitleaks and
semgrep. The artefact deployed is built once by `deploy.yml`, from the same commands.
