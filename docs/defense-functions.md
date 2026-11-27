# Defense runbook: cloud functions part

Part of the defense runbook (#79, subject 5.3). It covers what the serverless functions must show: the app on
**prd**, queue scaling, security of the functions and following one request through logs and traces. Anyone in the
team must be able to run it, not only the person who built it, so every step gives the command, what to expect and
what to do if it goes wrong.

Conventions: `$PRD=huiledecloud-cloudnative-prd`. `$GW` is the gateway URL of prd:

```bash
export PRD=huiledecloud-cloudnative-prd
terraform -chdir=infra/serverless init -reconfigure -backend-config=backends/prd.hcl >/dev/null
export GW=$(terraform -chdir=infra/serverless output -raw gateway_url)
export DASH=$(terraform -chdir=infra/serverless output -raw app_dashboard_url)
```

## Before the defense (D-1, then again 1 h before)

| Check | Command / place | Expected |
| --- | --- | --- |
| Last release deployed on prd | Actions → `deploy` run of the last tag | green, `prd` job included |
| Functions healthy | `gcloud functions list --project $PRD --format='table(name,state)'` | every function `ACTIVE` |
| Gateway up | `curl -s -o /dev/null -w '%{http_code}\n' $GW/health` | `200` |
| Discord signature check | `scripts/test-discord-proxy.sh $GW/discord/interactions` | every case `ok` (401) |
| Web API locked | `scripts/test-pixels-api.sh $GW` | every case `ok` (401 without a token) |
| Data private | `scripts/check-private-access.sh $PRD` | every case `ok` |
| Slash commands registered on the prd app | `DISCORD_BOT_TOKEN=… node commands/register.js --application-id <prd app id> --guild-id <guild> --dry-run` (in `app/functions`) | "Commands already up to date" |
| Discord endpoint | Developer portal → prd app → *Interactions Endpoint URL* = `terraform output discord_interactions_url` | saved without error (Discord PINGs it) |
| Admins configured | `discord_admin_role_ids` / `discord_admin_user_ids` in `infra/serverless/prd.tfvars` | the presenters' ids |
| No old failures | dashboard (`$DASH`), **DLQ** row | 0 waiting. Otherwise read them (§4) then purge: `gcloud pubsub subscriptions seek <channel>.dlq.sub --time=$(date -u +%FT%TZ) --project $PRD` |
| Canvas not paused | `/admin resume` in Discord | "▶️ Drawing is resumed." |
| Instructor access | instructor opens `$DASH` | dashboard visible (Editor on the project, `infra/access`) |

Keep open in browser tabs: the Discord channel, the web app (prd), `$DASH`, Logs Explorer and Cloud Trace on `$PRD`.

## 1. The app on prd (≈ 5 min)

| Step | Action | What the jury sees | Explain |
| --- | --- | --- | --- |
| 1 | `/draw x:500 y:500 color:red` | "thinking…" then "🎨 Pixel (500, 500) painted #ff0000." within a second or two; the pixel appears on the web app | proxy verifies the signature and defers in < 3 s; the command worker publishes `pixel.draw`; the draw worker writes Firestore; the front gets it through its listener |
| 2 | Brush stroke on the web app | pixels appear for every open browser | `POST /pixels` (202) → `pixel.draw` → draw worker, batch of up to 256 pixels in one transaction |
| 3 | Click a pixel (inspection), or `GET $GW/pixels/500/500` with a session token | colour, author, date | `pixel-reader`, read only, `datastore.viewer` |
| 4 | `/get x:500 y:500 size:16` | "🖼️ Canvas from (492, 492) to …" with a PNG of the area | read and render in the command worker, no write |
| 5 | Draw more than 20 pixels in a minute | extra pixels refused: "⏱️ Rate limit reached (20 pixels per minute), try again in N s." on Discord, rejected pixels on the web | quota read and written in the **same transaction** as the pixels: concurrent batches can't exceed it |
| 6 | `/admin pause`, then `/draw` | "⏸️ Drawing is paused, pixel (x, y) was not painted." | `session/state.paused`, checked by the draw worker |
| 7 | `/admin resume`, `/admin ratelimit user:@x limit:5`; the same from a non-admin | "▶️ Drawing is resumed.", "⏱️ @x can now draw 5 pixel(s) per minute."; non-admin: "⛔ You are not allowed to use this command." | admin = configured role/user ids only, fail closed |
| 8 | `/snapshot` | "📸 Snapshot requested…", then the message is replaced by a link to the PNG | snapshot worker writes a create-only object, the bucket notification triggers the notifier, which posts a V4 signed URL valid 1 h. The bucket stays private |
| 9 | (optional) `/admin clear` | canvas empty everywhere | a new generation (`clearedAt`), not 10¹⁰ deletions |

If a command shows "This interaction failed": the proxy did not answer in 3 s. Check `discord-proxy` logs (§4) and that
the endpoint URL of the app is the prd one.

## 2. Serverless and queue scaling (≈ 3 min)

Run with the load test of #76 (runbook there), or several people brushing at once.

On `$DASH`, from top to bottom:

1. **Functions**: requests/s of `draw-proxy` and `draw-worker` rise together; **instances** go up from 0 and back down
   after the burst (scale to zero).
2. **Queues**: the `pixel.draw.sub` backlog rises then drains; the oldest unacked age stays in seconds.
3. **Firestore**: writes/s follow the accepted pixels.
4. **Application**: `draw_batches` by outcome shows `rate_limited` once users pass their quota.
5. **Throttling (429)**: if it appears, `max_instances` (the cost ceiling) was reached. Pub/Sub retries with backoff,
   nothing is lost.

Explain: proxies only publish (fast, cheap), workers scale on the backlog, `max_instances` caps the bill, the DLQ
catches what fails five times.

## 3. Security of the functions (≈ 3 min)

| Point | Show |
| --- | --- |
| Discord signature | `scripts/test-discord-proxy.sh $GW/discord/interactions`: **401** without or with a wrong Ed25519 signature |
| No public function | Cloud Run → any function → *Security*: only the gateway SA (HTTP functions) or the push identity of its subscription (workers) has `run.invoker`; workers are *internal only* |
| Web API auth | `scripts/test-pixels-api.sh $GW`: 401 without a Firebase JWT, checked by the gateway before any function runs |
| Least privilege | IAM → one service account per function. `draw-proxy` has **no** Firestore role, `pixel-reader` and `snapshot-worker` are read-only, only `draw-worker` writes pixels |
| Secrets | Secret Manager: `discord-public-key`, the OAuth2 secret. Read at runtime by the function's SA, never in env vars or the repo |
| Private data | `scripts/check-private-access.sh $PRD`; a snapshot URL without its signature is refused (`scripts/test-snapshot-url.sh '<url>'`) |
| No key files | the functions call Google APIs with their SA through the metadata server; signed URLs and Firebase tokens use `signBlob` / `signJwt` on **their own** SA only |

## 4. Logs, traces, one request end to end (≈ 3 min)

1. `/draw x:501 y:501 color:blue`.
2. Logs Explorer on `$PRD`: `jsonPayload.message="batch applied" jsonPayload.user_id="<your discord id>"` → open the
   last line → copy `correlation_id`.
3. Query `jsonPayload.correlation_id="<id>"`: lines from `discord-proxy`, `command-worker` and `draw-worker`, all
   with the same correlation id.
4. On a line: *View trace details*. Cloud Trace shows one trace: proxy → `discord.command` publish → command worker →
   `pixel.draw` publish → draw worker → `firestore transaction draw` → Discord answer. The gaps between publish and
   process are the time spent in the queue.
5. Other ready-made queries: `docs/observability.md` § Logs Explorer queries (errors, rate-limited users, refused
   admin commands, one user's activity).

### Forced failure → DLQ

```bash
scripts/demo-dlq-failure.sh $PRD pixel.draw
```

The worker refuses the broken message (400) five times, then the message lands in `pixel.draw.dlq.sub`: the **DLQ**
row of `$DASH` shows it within a few minutes, and *function errors* shows the five attempts. Read it with
`gcloud pubsub subscriptions pull pixel.draw.dlq.sub --limit 5 --project $PRD`, purge with `--auto-ack`.

Start it at the beginning of §4: the message needs a few minutes to be dead-lettered.

## Questions to expect

| Question | Short answer | Doc |
| --- | --- | --- |
| What if Pub/Sub delivers a message twice? | Idempotency markers written in the same transaction as the effect; the stored outcome is replayed | `data-model.md` §6 |
| Why not write Firestore from the proxy? | 3 s Discord limit, independent scaling, retries and DLQ; the proxy has no Firestore role at all | `functions.md` § Design choices |
| How do two people drawing the same pixel interact? | Last write wins on the server timestamp; the document is written whole, never mixed | `data-model.md` |
| How is a 100 000 × 100 000 grid stored? | One document per drawn pixel, `tile` field for 256×256 tiles; empty cells cost nothing | `data-model.md` |
| What stops a user from flooding? | Gateway JWT, then a quota in the draw transaction, `max_instances`, then the DLQ | `functions.md` |
| How do you know something is broken? | Dashboard (5xx, backlog, DLQ, function errors), structured logs, traces | `observability.md` |
| Why these libraries? | Official Google / OpenTelemetry clients only, lockfile, `npm audit` on every PR | `open-source-functions.md` |

## If something breaks during the demo

| Symptom | First check | Fallback |
| --- | --- | --- |
| "This interaction failed" | `discord-proxy` logs; endpoint URL of the prd app | show the same flow on dev, or the end-to-end test `test/lib/trace.test.js` |
| `/draw` answers but no pixel on the web | `draw-worker` logs, `pixel.draw.sub` backlog | Logs Explorer by correlation id shows where it stopped |
| `/snapshot` never answers | `snapshot-worker` / `snapshot-notifier` logs, `snapshot.ready.dlq.sub` | the interaction token lasts 15 min: run it again |
| 429 everywhere | `max_instances` reached: that is the cost ceiling working | let the backlog drain on the dashboard |
