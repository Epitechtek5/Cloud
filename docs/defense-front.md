# Defense runbook: front part

Part of the defense runbook (#79, subject 5.3), next to `defense-functions.md` (cloud functions, #133)
and the infra part (#83). It covers what the front must show: the app on **prd**, the security of the public edge
(hosting, login, session, Firestore rules) and the pipeline that ships the front. Anyone in the team must be able to run
it, not only the person who built it, so every step gives the command, what to expect and what to do if it goes wrong.

Same conventions as the functions part, so the commands can be pasted one after the other:

```bash
export PRD=huiledecloud-cloudnative-prd
terraform -chdir=infra/serverless init -reconfigure -backend-config=backends/prd.hcl >/dev/null
export APP=$(terraform -chdir=infra/serverless output -raw app_url | sed 's:/$::')   # https://<ip>.sslip.io
export GW=$(terraform -chdir=infra/serverless output -raw gateway_url)
export HOST=${APP#https://}
```

`TODO(prd)` marks what is only known once prd is deployed with the open PRs (an IP, a Discord application id, a
coordinate). Replace it in the rehearsal and remove the marker.

## Prerequisites (what must be merged and deployed first)

The front is only as live as the services behind it. Check each line before relying on the matching step.

| Needed for | Prerequisite | State when this was written |
| --- | --- | --- |
| Front served on prd (§2) | `infra/serverless` applied on prd (bucket, load balancer, certificate, gateway) | `TODO(prd)`: confirm the first prd deploy ran; `app_url` and `frontend_ip` come from its outputs |
| Login (§1, §2) | prd Discord application: `discord_client_id`, `auth_discord_redirect_uris` (= `$APP/`) in `infra/serverless/prd.tfvars`, versions of the `discord-oauth-client-secret` secret | `TODO(prd)`: `prd.tfvars` has no `discord_client_id` yet, so `auth-discord` is not deployed on prd |
| Real time (§1) | `auth_discord_firebase_custom_token = true`, Firebase Authentication enabled, `firebase_api_key` in `prd.tfvars` | `TODO(prd)`: off by default, `config.json` warns while the key is empty |
| The front talks to GCP instead of the mock | #139 (GCP adapter of the front) | not merged |
| Brush, inspection, rejections | #126 to #128 (command worker, draw worker, `POST /pixels` and `GET /pixels/{x}/{y}`) | not merged; until then the gateway answers `501` on these routes |
| Fast loading of a large grid | #68 (tile rasters, `/tiles/*` route) | not merged; without it every tile is rebuilt from Firestore (`/tiles/*` answers 404, the front falls back, but slower and costlier) |
| `X-Correlation-Id` in logs and traces (§4) | #131 (tracing), #133 / #132 (functions docs) | not merged |
| Discord Activity (§1) | URL mappings of the prd application (`docs/discord-activity.md` §1), question E (Firestore inside the Discord iframe) tested once | `TODO(prd)`: mappings and test pending |

If a prerequisite is missing on the day, use the fallbacks of the last section: the same demo runs on **dev**.

## Before the defense (D-1, then again 1 h before)

| Check | Command / place | Expected |
| --- | --- | --- |
| Last release deployed on prd | Actions → `deploy` run of the last tag | green, `deploy-prd` job included (its smoke tests curl `app_url` and `$GW/health`) |
| Certificate active | `gcloud compute ssl-certificates list --project $PRD --format='table(name,managed.status,managed.domains)'` | `ACTIVE`, domain = `$HOST` |
| App answers | `curl -s -o /dev/null -w '%{http_code}\n' $APP/` | `200` |
| HTTP redirects | `curl -sI http://$HOST/ \| head -1` | `301` |
| Runtime config is prd's | `curl -s $APP/config.json \| jq` | `env` = `prd`, `apiBase` = `$GW`, `discordClientId` and `firebase.apiKey` not empty |
| Front bucket private | `curl -s -o /dev/null -w '%{http_code}\n' https://storage.googleapis.com/$PRD-frontend/index.html` | `401` or `403` |
| Gateway up, web API locked | `curl -s -o /dev/null -w '%{http_code}\n' $GW/health`, `scripts/test-pixels-api.sh $GW` (#128) | `200`; every case `ok` (401 without a token) |
| Data private, Firestore refuses a write | `scripts/check-private-access.sh $PRD` | every case `ok` |
| Discord portal (prd application) | OAuth2 → Redirects contains `$APP/`; Activities enabled; URL mappings `/`, `/api`, `/firestore`, `/identitytoolkit`, `/securetoken` | as in `docs/discord-activity.md` §1 |
| Login works on prd, web **and** Activity | log in with each presenter's Discord account | canvas appears, no error banner |
| Something to look at | draw a recognisable shape near `TODO(prd)` coordinates (and one far from the centre) | visible at zoom ≈ 2 |
| Canvas not paused | `/admin resume` in Discord | tools enabled in the front |
| Instructor access | instructor opens `$APP` | page loads (it is public by design, login needed to draw) |

Browser preparation, once: two profiles (or one normal and one private window) logged in with two different Discord
accounts, DevTools open on **Network** (filter `Fetch/XHR`, *Preserve log* on) in the first one, zoom 100 %, ad blocker
off. Keep open: the Discord channel, `$APP` twice, Logs Explorer and Cloud Trace on `$PRD`, the GitHub *Actions* page.
A non-published Activity can only be launched by members of the application's team, so the **presenter** launches it
and shares their screen: the instructor cannot.

Hardware (subject 5.1, per member): microphone, webcam, stable connection, screen sharing of one window **and** of a
whole screen tried once on Teams. No AI assistant open during the defense (subject 5.5).

## 1. The app on prd (≈ 5 min)

Open the Activity from a voice channel first (it is what Discord users see), then the web app in a browser.

| Step | Action | What the jury sees | Explain |
| --- | --- | --- | --- |
| 1 | Discord → voice channel → *Activities* → the prd app | Discord asks for the `identify` permission only, then the canvas loads inside Discord | same code as the web app; the page is an iframe served through the Discord proxy (`<app_id>.discordsays.com`), login by `sdk.authorize` (PKCE) then `POST /auth/discord` |
| 2 | Open `$APP` in the browser, *Login with Discord* | redirect to Discord (`identify` only), back on the app with the canvas | OAuth2 code + PKCE + `state`, the code is exchanged by the `auth-discord` function, the browser never sees the client secret |
| 3 | Two clients side by side (Activity or window 1, window 2 with another account): brush in one | the pixels appear in the other **without reload**; DevTools shows no periodic request, only the long-lived Firestore `Listen` connection | Firestore listener per visible tile, read only; `setInterval` is forbidden by ESLint (`app/frontend/eslint.config.js`) |
| 4 | Large grid: type `99900, 99900` in *go to*, then `0, 0`; zoom with the wheel (0.5× to 48×), pan, keys `+` `-` and arrows | the whole 100 000 × 100 000 grid is reachable; press `d` for the debug overlay: tiles kept, tiles loading, deltas received, frame time | only the visible tiles (+1 tile margin) are loaded, as 256 × 256 rasters, and each one gets a listener; leaving the viewport drops both |
| 5 | Network tab, filter `tiles/` (after #68) | one small PNG per tile, with an `X-Tile-Version` response header | raster first, then a listener `t > version`: nothing lost between the two |
| 6 | Brush: `B`, size `[` / `]` (1 to 32), drag a stroke | the pixels show at once (optimistic), then are confirmed by the real-time echo | strokes are interpolated, de-duplicated and sent in batches of at most 256 pixels: `POST /pixels` answers `202`, the worker writes |
| 7 | Draw more than 20 pixels in a minute | the extra pixels disappear with a message | the **worker** refuses them (rate limit in the draw transaction) and writes a `userEvents` document; the front listens to its own rejections and removes the optimistic pixels |
| 8 | Inspect: `V`, click a pixel | colour, author, date; `Pixel never painted` on an empty one | `GET /pixels/{x}/{y}`, read only, JWT checked by the gateway |
| 9 | Discord `/admin pause` | front tools disabled; `/admin resume` enables them again | `session/state` document, same real-time channel |

If a step shows nothing: §4 (find the request by its correlation id) tells where it stopped.

## 2. Security of the front (≈ 4 min)

| Point | Show | Expected | Explain |
| --- | --- | --- | --- |
| Front bucket is private | `curl -si https://storage.googleapis.com/$PRD-frontend/index.html \| head -1`, then `gcloud storage buckets describe gs://$PRD-frontend --format='yaml(public_access_prevention,uniform_bucket_level_access)'` | `401`/`403`; `enforced`, `true` | `public_access_prevention = enforced`: GCP refuses any `allUsers` binding. The only reader is the load balancer service agent (`roles/storage.objectViewer` **on this bucket**) |
| No public binding | `gcloud storage buckets get-iam-policy gs://$PRD-frontend --format=json \| jq -r '.bindings[].members[]' \| sort -u` | no `allUsers` / `allAuthenticatedUsers`; the `https-lb` agent is listed | resource-level IAM, nothing added to the project roles |
| Other buckets and Firestore closed | `scripts/check-private-access.sh $PRD` | every case `ok`: listing and reading the tiles and snapshots buckets are refused, an anonymous Firestore write is refused by the rules | the script checks the **tiles** and **snapshots** buckets and Firestore; the front bucket is the two commands above |
| HTTPS | `curl -sI http://$HOST/ \| head -3`, then `curl -sI $APP/ \| grep -i -E '^(HTTP\|strict-transport\|x-content\|referrer)'`, then the certificate command of the checklist | `301` to https; HSTS, `nosniff`, `Referrer-Policy`; certificate `ACTIVE` | Google-managed certificate (renewed automatically), TLS 1.2 minimum, port 80 only redirects, HSTS. The host is `<ip>.sslip.io` because no domain was bought |
| CDN | `f=$(curl -s $APP/ \| grep -o 'assets/[^"]*\.js' \| head -1); curl -sI $APP/$f \| grep -i -E 'cache-control\|age'` twice, then `curl -sI $APP/config.json \| grep -i cache-control` | `public, max-age=31536000, immutable` and an `age` header on the second call; `no-cache` for `config.json` | Cloud CDN in front of the private bucket. Hashed assets are cached for a year, `index.html` and `config.json` are always revalidated: a deploy needs no invalidation. `TODO(prd)`: confirm the `age` header at the first rehearsal (`USE_ORIGIN_HEADERS` on a private bucket was designed, not yet observed) |
| No function callable without the gateway | `u=$(gcloud functions describe health --gen2 --region <functions region> --project $PRD --format='value(serviceConfig.uri)'); curl -s -o /dev/null -w '%{http_code}\n' $u` | `403` (`<functions region>` = `region` of `prd.tfvars`, `europe-west9`) | `roles/run.invoker` belongs to the gateway service account only, never `allUsers`. The lock is IAM, not the network. The same call through `$GW/health` answers `200` |
| Gateway checks the session | `curl -si $GW/pixels/1/1 \| head -1` and `scripts/test-pixels-api.sh $GW` | `401` without a token, with garbage or with a forged one | the JWT (signature, `iss`, `aud`, `exp`) is verified **at the gateway**, before any function runs |
| Discord login | the consent screen of step 2 of §1, then Logs Explorer: `resource.type="cloud_run_revision" resource.labels.service_name="auth-discord" SEARCH("access_token")` | consent lists only the `identify` data; no log line | scope `identify` only. The access token lives for the time of one request (and in the Activity iframe for the SDK); the refresh token is never read or stored; the front keeps the session token in memory only: DevTools → Application → *Local storage* / *Session storage* are empty |
| Session JWT | DevTools → Network → `POST /auth/discord` → response `token`, then `echo "$TOKEN" \| jq -R 'split(".") \| .[0:2][] \| gsub("-";"+") \| gsub("_";"/") \| @base64d \| fromjson'` | header `alg` RS256; payload `sub` = your Discord id, `username`, `exp - iat = 600` | our own short token (10 min), signed by the `auth-discord` service account through IAM `signJwt`: no private key to store or rotate; Google publishes the public keys the gateway checks against |
| Firestore: the browser cannot write | `scripts/check-private-access.sh $PRD` last case, then `infra/serverless/firestore.rules` (`allow write: if false`) and the `ci-firestore-rules` run (emulator tests) | anonymous write refused: `Missing or insufficient permissions` | rules deployed by Terraform. Only workers write, through the Admin SDK and their own service account (IAM, rules do not apply to them). Reads need a **custom** Firebase token minted by our login, `pixels` queries must have `limit <= 65536`, `users` and `userEvents` only for their owner |
| Same, as a signed-in user | take `firebaseToken` from the `POST /auth/discord` response, exchange it: `curl -s -X POST "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=<firebase.apiKey of config.json>" -H 'Content-Type: application/json' -d '{"token":"<firebaseToken>","returnSecureToken":true}' \| jq -r .idToken`, then `curl -s -X PATCH -H "Authorization: Bearer <idToken>" -H 'Content-Type: application/json' -d '{"fields":{"c":{"integerValue":"0"}}}' "https://firestore.googleapis.com/v1/projects/$PRD/databases/(default)/documents/pixels/0_0"` | `PERMISSION_DENIED` ("Missing or insufficient permissions") even with a valid session | optional, stronger proof: authenticated, still refused. **Not run yet**: rehearse it once (the custom token is valid for one hour) |
| What is public, and why | `curl -s $APP/config.json \| jq` | `env`, `apiBase`, `discordClientId`, `firebase.{apiKey,projectId,authDomain}` | a **Firebase web API key** only identifies the project, it grants nothing (Firestore rules and IAM do); a Discord **client id** is in every authorize URL by design. Secrets (Discord client secret, bot token, public key) are in Secret Manager and never reach the front or the repo |

Do not show the Discord client secret, a session token or a Firebase token on a shared screen: blur or revoke
afterwards (they expire in 10 min and 1 h).

## 3. Pipeline of the front (≈ 2 min)

1. **PR** from a branch to `dev`, title in Conventional Commits (`pr-title.yml`), commits signed (`git log --format='%h %G? %an %s' -10` shows `G`).
2. **`ci-frontend`** (Actions → run of a front PR): job `test` runs `npm ci`, `npm run lint` (ESLint, includes the no-polling rule), `npm run typecheck`, `npm test` (Vitest) and `npm run build`; job `audit` runs `npm audit --omit=dev --audit-level=high` with the justified, expiring exceptions of `app/frontend/audit-exceptions.json` ([dependency-audit.md](ci/dependency-audit.md)). `ci-security` adds gitleaks and Semgrep. Jobs run on the pool named by the `CI_RUNNER` variable (our self-hosted runners when set).
3. **Review and merge** into `dev` → `deploy.yml` deploys **dev**. A release PR `dev` → `main` (`check-source-branch`, `ci-gate`) then merges and `release.yml` (semantic-release) creates the `vX.Y.Z` tag ([release.md](ci/release.md)).
4. **The tag** triggers `deploy.yml`: job `build` builds the front **once** (`npm ci && npm run build`, uploaded as artifact `app-<sha>`); job `deploy-prd` waits for a required reviewer of the `prd` environment, then `deploy-env.yml` **downloads that artifact and does not rebuild**. Terraform uploads `frontend/**` to the private bucket and writes `config.json` from `prd.tfvars`, then the smoke tests curl `app_url` and `$GW/health`.
5. **Proof that the build holds nothing about an environment**: `curl -s $APP/config.json | jq .env` is `prd` while the same call on dev says `dev`; `curl -s $APP/$f | grep -c <discordClientId>` (the `$f` of the CDN row) finds nothing. The front reads `/config.json` at startup (`app/frontend/src/runtimeConfig.ts`).

Say it precisely if asked: dev and prd are deployed by two runs of `deploy.yml` (branch push, then tag), each building
once and deploying that build to a single environment ([release.md](ci/release.md)). What is guaranteed identical is
the build process and the absence of any environment value in the bundle; the byte-identical artifact is not carried
from the dev run to the tag run.

## 4. Observability seen from the front (≈ 2 min)

The front has no telemetry of its own (no analytics, no browser tracing): it **originates the correlation id**.

1. DevTools → Network → click a `POST /pixels` (brush stroke) → *Request Headers* → `X-Correlation-Id: <uuid>`. The same header is sent on `POST /auth/discord`, and on every gateway call once #139 is merged (a fresh `crypto.randomUUID()` per request).
2. The proxy answers with the same header and copies the id into its logs and into the `pixel.draw` event.
3. Logs Explorer on `$PRD`: `jsonPayload.correlation_id="<uuid>"` → lines of `draw-proxy` and `draw-worker`; open a line → *View trace details* → one Cloud Trace waterfall from the gateway to the Firestore transaction (#131, `observability.md`, added with #133).
4. If a brush stroke seems lost, this is how to tell where it stopped: no line = the gateway refused it (401, check the token age); proxy line only = the queue; worker line with `rate_limited` or `paused` = a legitimate rejection the front shows.

## Questions to expect

| Question | Short answer | Doc |
| --- | --- | --- |
| Why Canvas 2D and no framework or WebGL? | One `<canvas>`; each 256 × 256 tile is an offscreen canvas blitted with `drawImage` and smoothing off, which is exactly what is needed to show square pixels. About 100 tiles at the minimum zoom is cheap for 2D, no runtime dependency, nothing to audit. WebGL would only pay off with millions of moving objects | `app/frontend/README.md` |
| Why 256 × 256 tiles? | 391 × 391 tiles cover the grid, about a hundred on screen at the minimum zoom, a PNG of a few KiB. 64 would multiply listeners and requests by 16; 1024 would download many pixels out of view. It is also the usual web-map size. 512 is the alternative (provisional decision C) | `data-model.md` §2 |
| Why a raster **and** deltas? | A raster loads thousands of pixels in one small request; Firestore then only sends what is newer than the raster (`t > version`). Without the raster a tile costs up to 65 536 document reads per open; without deltas the picture would be stale | `data-model.md` §4, `frontend-contract.md` §3 |
| How do you not lose a pixel between the raster and the listener? | The listener starts at the raster's version (`X-Tile-Version`, the newest pixel time inside it). A pixel can arrive twice, never zero times | `frontend-contract.md` §3 |
| Why no polling? | Subject: real time without refresh button. Firestore pushes changes over one long-lived connection per client, `setInterval` is banned by ESLint, the quota display uses a single `setTimeout` | `app/frontend/README.md`, rules |
| How does real time work with Firestore? | The browser signs in with a custom token minted by our login, then runs `where tile == "tx_ty" and t > v orderBy t limit 65536` per visible tile (composite index `(tile, t)`). A write by a worker triggers a snapshot on every listener of that tile | `frontend-contract.md` §3 |
| Why read the config at runtime? | Build once, deploy everywhere: the bundle has no URL, client id or key. `config.json` is written by Terraform from the tfvars of each environment and served `no-cache` | `infra/serverless/README.md` |
| How does the front authenticate? | Discord OAuth2 code + PKCE (`identify`), exchanged by the `auth-discord` function for a 10-minute JWT (and a Firebase custom token), kept in memory. The gateway checks the JWT; Firestore rules check the Firebase token | `discord-activity.md` §2, §6 |
| Where is the Discord token stored? | Nowhere. It lives for one request on the server; in the Activity it is handed to the Discord SDK. The refresh token is dropped | `discord-activity.md` §2 |
| Can the browser write to the database? | No. Rules say `write: if false`; drawing is `POST /pixels` → proxy → Pub/Sub → worker | `firestore.rules` |
| Why a load balancer when "everything goes through the API Gateway"? | Subject 3.4 allows static hosting + CDN. It only serves files from a private bucket; no function is exposed by it | `infra/serverless/README.md` |
| Why not Firebase Hosting? | Terraform cannot upload the files, and its rewrites to a function need an unauthenticated function, which the subject forbids | `infra/serverless/README.md` |
| Why an `sslip.io` host? | A managed certificate needs a domain that resolves to the load balancer's IP and we had none. The IP is reserved by `infra/access`, so the host survives a destroy. With a real domain: `frontend_domain` + one A record | `reproducibility.md` |
| What about XSS and token theft? | The token is in memory only, never in `localStorage`; the app escapes the text it injects into HTML (`escapeHtml` in `src/ui/hud.ts`). There is no Content-Security-Policy yet (it must allow Discord's iframe and Firestore): a known gap | `discord-activity.md` §6 |
| The grid is 100 000 wide but the zoom stops at 0.5×? | Yes: at 0.5× only about 1 % of the width fits. The *go to* form teleports; an overview layer (mini-map) is future work | `app/frontend/README.md` |

## If something breaks during the demo

| Symptom | First check | Fallback |
| --- | --- | --- |
| Activity does not load or stays blank | Discord portal mappings, `/config.json` reachable, question E (Firestore in the iframe) | open `$APP` in the browser and run the same steps there; say that the Activity is the same page in an iframe |
| Login fails ("Login failed (HTTP n)") | `401 invalid_grant`: code reused, reload; `400 invalid_redirect_uri`: the redirect URI is not `$APP/` in `auth_discord_redirect_uris`; `502`: Discord or IAM `signJwt` | log in on dev; show the `auth-discord` logs |
| Banner "configuration" at startup | `curl -s $APP/config.json`: empty `apiBase`, `discordClientId` or `firebase.apiKey` | fix the tfvars and redeploy; meanwhile demo on dev |
| Pixels appear locally then vanish | rejected (20 px/min, paused) or no worker: §4 with the correlation id | `/admin resume`, wait a minute |
| Nothing appears in the second client | Firestore listener (DevTools Network, `Listen`), custom token not enabled, rules | reload the second client; show the same on dev |
| Tiles slow or missing | #68 not deployed: `/tiles/*` answers 404 | say so: tiles come from Firestore only, the design with rasters is in `data-model.md` §4 |
| HTTPS error or certificate warning | `gcloud compute ssl-certificates list`: still `PROVISIONING` (up to about an hour) | dev URL |
| Session expired in the middle (10 min) | any `401` | reload and log in again |
| Screen sharing fails | Teams settings, share a single window | another member shares while the presenter speaks |
