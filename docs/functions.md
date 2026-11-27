# Functions: layout and shared runtime library

`app/functions` holds every Cloud Run function of the platform. Each function does one thing (SRP, subject 3.1),
and they all share the same plumbing in `src/lib` (C05 §6, C08 §6).

## Layout

```
app/functions/
  package.json        one package, one artifact (functions.zip) for every function
  src/index.js        exports every entry point; Terraform picks one per function (entry_point)
  src/<function>/     code of one function (proxy or worker), thin, built on src/lib
                      e.g. src/discord: Discord interactions proxy (docs/discord-bot.md)
                      src/commands: command worker (docs/discord-bot.md)
                      src/draw: draw worker, the only writer of the grid (below)
                      src/pixels: web API, POST /pixels and GET /pixels/{x}/{y} (below)
                      src/snapshot: snapshot worker and notifier (below)
  src/lib/            shared runtime library (below)
  test/               node:test unit tests (test/lib for the library)
  test/emulator/      Firestore tests, run against the emulator (skipped by plain `npm test`)
  firebase.json       port of the Firestore emulator used by the tests
```

- **Build and test**: `ci-functions.yml` runs `npm run lint`, `npm run test:ci` (every test, `test/emulator`
  included, under the Firestore emulator, with coverage: fails under 90 % lines, 80 % branches, 90 % functions of
  `src`), `npm run build` and zips `dist/`. Locally: `npm test` (no emulator, Firestore tests skipped) or
  `npm run test:emulator` (needs Java 21+; `firebase-tools` is fetched by `npx`, not a dependency).
- **Packaging**: `deploy.yml` builds the same `functions.zip` once and passes it to Terraform
  (`app_artifact_dir`); each function is one `modules/function` instance in `infra/serverless/functions.tf`,
  with its own `entry_point` and its own service account (see `infra/serverless/README.md`).

## Shared library (`src/lib`)

| Module | What it gives |
| --- | --- |
| `logger.js` | `createLogger(fields)`: one JSON line per entry on stdout (stderr from `ERROR`), with `severity`, `message`, `function`, `event_type`, `correlation_id`, `trace_id`, `span_id`, `user_id`, and `logging.googleapis.com/trace` so that Cloud Logging attaches the entry to its trace. `LOG_LEVEL` filters (`WARN` is accepted for `WARNING`, an unknown value falls back to `INFO`); fields never override `severity` or `message`. |
| `correlation.js` | `correlationFromHeaders` (`X-Correlation-Id` if safe, a new UUID otherwise), `correlationFromAttributes` (`correlation_id` of a message), `traceFromHeaders` (`traceparent` or `X-Cloud-Trace-Context`). |
| `context.js` | `httpContext(req)` for proxies and `messageContext(attributes)` for workers: correlation id, trace and a logger bound to both. |
| `events.js` | Schemas of `discord.command`, `pixel.draw`, `pixel.processed`, `snapshot.requested`, with `validateEvent` / `assertEvent`. Grid `0..99999`, colour `0..0xFFFFFF`, 1 to 256 pixels per batch (also the cap of `pixel.processed`). `/admin clear` is `pixel.processed` with `cleared: true` and no pixels, never per-pixel deltas. Unknown fields, prototype keys included, are refused. |
| `publisher.js` | `createPublisher({ source })`: validates the event, publishes it as JSON on the topic named after its type, with the `correlation_id`, `event_type` and `source` attributes. |
| `pubsubPush.js` | `decodePushMessage(body, { expect })`: decodes and validates a Pub/Sub push request on the worker side; `expect` refuses any event type the worker does not handle. |
| `secrets.js` | `createSecretReader()`: Secret Manager access, cached in memory per instance (one call per secret, failures not cached, including a failed client import). |
| `worker.js` | `createPushHandler({ expect, handle })`: HTTP plumbing of a push worker. `204` acks, `400` for a broken message (retries then DLQ), `500` when `handle` throws (retried). |
| `firestore.js` | `getFirestore()`: lazy Firestore client (emulator when `FIRESTORE_EMULATOR_HOST` is set), `toMillis`. |
| `grid.js` | Tiles (`tileOf`, `tilesOfRect`, 256x256), `pixelId`, `inGrid`, collection names. |
| `canvas.js` | `readSession` (`paused`, `clearedAt`), `readRegion` (pixels of a square, newer than the last clear), `renderRegion` (RGBA, scaled). |
| `png.js` | `encodePng(width, height, rgba)`: PNG encoder on `node:zlib`, no image dependency. |
| `pngDecode.js` | `decodePng(png)`, `readPngText(png)`: the matching decoder (8-bit RGB/RGBA), used to read the tile rasters. |
| `storage.js` | `getStorage()`: lazy Cloud Storage client. |
| `discordWebhook.js` | `createInteractionClient()`: `editOriginal` / `followUp` of an interaction (JSON or multipart with files), errors flagged `retryable`. |
| `snowflake.js` | `snowflakeTime(id)`: creation time of a Discord id. |
| `tracing.js` | `initTracing()` hook, a no-op until the tracing issue registers the OpenTelemetry bootstrap. |

## Correlation id, end to end

```
client --X-Correlation-Id--> proxy: httpContext(req) -> log + publish(..., { correlationId })
        Pub/Sub message attribute correlation_id
worker: decodePushMessage(body) -> messageContext(attributes) -> log (same correlation_id)
```

Raw payloads are never logged: `discord.command` carries the interaction token (valid about 15 minutes), and validation
errors only name the invalid paths, never their values. Log ids (`batchId`, `userId`), not events.

In Cloud Logging, `jsonPayload.correlation_id="<id>"` shows every log line of one request, from the proxy to the
last worker. `test/lib/context.test.js` checks this path.

## Example (proxy)

```js
import { createPublisher, httpContext } from "../lib/index.js";

const publisher = createPublisher({ source: "draw-proxy" });

export async function drawProxy(req, res) {
  const { correlationId, log } = httpContext(req, { functionName: "draw-proxy" });
  await publisher.publish("pixel.draw", event, { correlationId });
  log.info("batch accepted", { batchId: event.batchId });
  res.status(202).json({ batchId: event.batchId });
}
```

## Draw worker (`src/draw`, #65)

Consumes `pixel.draw` (web brush batches and `/draw`) through `pixel.draw.sub`. One Firestore transaction per
batch (`store.js`):

1. reads `processedBatches/{batchId}`, `session/state` and `users/{uid}`; a batch whose marker exists is not
   applied again (its stored outcome is replayed: `pixel.processed` again, same Discord answer);
2. `rules.js` decides: everything rejected (`paused`) while paused; otherwise a **fixed window** of 60 s,
   `limit = users/{uid}.override ?? DEFAULT_RATE_LIMIT` (20), and a batch over the quota is **partially accepted**
   (the first pixels, duplicates within a batch counted once, last colour wins);
3. writes each accepted pixel whole, `{x, y, tile, c, a, an, t: serverTimestamp}` (last write wins by server
   time, never a mix of two draws), the quota `{limit, used, windowStart}`, the rejected pixels in
   `userEvents/{batchId}` (`reason`, `pixels`, TTL 1 h) and the marker (TTL 8 days).

Then it publishes `pixel.processed` (accepted pixels, rejected with their reason) and edits the `/draw` answer.
A batch that fails validation but names its author (`batchId`, `user.id`) is recorded as `invalid` in
`userEvents` and acked; an anonymous broken message answers `400` and ends in `pixel.draw.dlq`. Concurrent
batches of one user cannot exceed the limit: the transaction locks `users/{uid}` (`PESSIMISTIC` database).

Tests: `test/draw` (rate limit window, override, partial batch, pause, replies, statuses) and
`test/emulator/drawStore.test.js` (21 pixels in a minute: 20 accepted + 1 `userEvents`; redelivery, concurrent
redeliveries and concurrent batches without double counting; two concurrent writers of one pixel; pause;
override; invalid batch).

## Web API (`src/pixels`, #66)

Behind the API Gateway, which checks the session JWT and forwards its claims in `X-Apigateway-Api-Userinfo`
(`http.js`, `gatewayUser`: no user → `401`, so a route deployed without `security` fails closed). Each answers its
own CORS preflight (`ALLOWED_ORIGINS`, the origins of `auth_discord_redirect_uris`).

- `draw-proxy` (`drawProxy.js`), `POST /pixels`: builds the `pixel.draw` event (user = JWT `sub`, never taken from
  the body; `source: web`), validates it with the shared schema (unknown fields refused), publishes it with the
  `X-Correlation-Id` and answers `202 {batchId}`. `400` lists the invalid paths, never the values; `503` if Pub/Sub
  fails. Its account has no Firestore role at all.
- `pixel-reader` (`pixelReader.js`), `GET /pixels/{x}/{y}`: `200 {x, y, color, author, authorName, ts}`, `404` when
  never painted or older than `session/state.clearedAt`. `roles/datastore.viewer` only.

Tests: `test/pixels` (401 cases, 400 matrix, 202 event, CORS, 503, reader statuses) and
`test/emulator/pixelReader.test.js` (draw → read → clear → 404). Live, through the gateway:
`scripts/test-pixels-api.sh <gateway_url>` (`401` without or with a forged token; with `SESSION_TOKEN`, also
`400`, `202` and the read back).

## Snapshot workflow (`src/snapshot`, #69)

```
/snapshot -> command worker -> snapshot.requested -> snapshot-worker
             reads every visible pixel, renders a PNG, creates snapshots/YYYY/MM/DD/<time>_<request>.png
bucket OBJECT_FINALIZE -> snapshot.ready (storage notification) -> snapshot-notifier
             signs a V4 URL (IAM signBlob, no key), edits the /snapshot answer with the link
```

- **What the image shows** (`compose.js`): the 100 000² grid would be 40 GB of RGBA, so the snapshot is the square
  around the painted area (8 px margin): 1:1 up to 2048 px, otherwise downscaled (most recent pixel of each block),
  enlarged to at least 512 px. Pixels older than the last `/admin clear` are left out. At most
  `MAX_SNAPSHOT_PIXELS` (2 million) are read; past that the snapshot is flagged `truncated`.
- **Timestamped, once**: the name comes from `requestedAt` (the interaction's snowflake time), so a redelivery
  writes the same name; the upload is create-only (`ifGenerationMatch: 0`), a `412` means "already done" and the
  notifier is triggered once. The object metadata carries what the notifier needs (request id, author,
  correlation id, application id and interaction token): it is triggered by the bucket, not by the worker.
- **Notifier**: edits the deferred `/snapshot` answer (idempotent on redelivery). Link lifetime
  `SIGNED_URL_TTL_SECONDS` (Terraform `snapshot_url_ttl_seconds`, 1 h by default). The bucket is private
  (`public_access_prevention = enforced`): without the signature the object answers `403`.
- **Identities**: `fn-snapshot-worker` has `datastore.viewer` and `storage.objectCreator` on the bucket (no read, no
  overwrite); `fn-snapshot-notifier` has `storage.objectViewer` on the bucket and `iam.serviceAccountTokenCreator`
  on itself only. The bucket's lifecycle deletes snapshots after 7 days (dev) or 90 days (prd).

Tests: `test/snapshot` (composition 1:1 and downscaled, object name, metadata, create-only upload, notifier:
link, ignored events, DLQ, retries, a real V4 URL signed with a throwaway key: `X-Goog-Expires` equals the
lifetime) and `test/emulator/snapshotStore.test.js`. Live: `scripts/test-snapshot-url.sh '<link>' [--wait]`
(200 signed, 403 unsigned, refused after expiry).

## Tile rasters and `/get` (`src/tiles`, #68)

```
draw worker --pixel.processed--> tile-renderer --PNG 256x256 + version--> bucket <project>-tiles (private)
browser --HTTPS--> LB + Cloud CDN --/tiles/{tx}/{ty}.png--> backend bucket --> bucket (object tiles/{tx}/{ty}.png)
/get --> command worker --readRegion--> rasters (+ pixels newer than each raster)
```

- **Current tile** (`current.js`), the one recipe used everywhere (and by the front, contract §3): the stored raster, plus
  the pixels with `t >` its version (one query on the `(tile, t)` index), applied on top. A raster at least as old as the
  last `/admin clear` is not used (start again from an empty tile, `t > clearedAt`).
- **Tile renderer** (`renderer.js`, `state.js`): consumes `pixel.processed`, finds the touched tiles, and for each one claims
  a lease (`tileState/{tx}_{ty}`), renders, stores the PNG, and renders again at most once per `RENDER_MIN_INTERVAL_MS`
  while more messages arrived: see `docs/data-model.md` §4 for the reasoning. Writes are conditional on the object
  generation (`bucket.js`), so two renderers never overwrite each other. A message that cannot finish within
  `RENDER_BUDGET_MS`, or a tile that fails, answers `500`: Pub/Sub retries, the rendering is idempotent. The leader of a tile is
  named after the Pub/Sub `messageId`, which a redelivery keeps: if an instance is killed without giving the tile back, the
  redelivery of its message takes the tile at once instead of waiting for the lease to expire. A render only writes when the
  image changed (compared on the pixels, not on the number read: `t > version` returns the newest pixel at every read).
  The sweep after `/admin clear` (`deleteStale`) deletes while it lists and stops at the same budget (`500`, the retry continues).
- **Version** (`raster.js`): `floor(ms)` of the newest pixel `t` in the raster, stored as the `Tile-Version` `tEXt` chunk of the
  PNG (the image and its version are one object) and as object metadata `tile-version` (listable without downloading).
  Rounding down only ever repeats a pixel on the front, rounding up would lose some.
- **Delivery** (no function, `infra/serverless/tiles.tf`): the front's load balancer reads the private bucket through a backend bucket
  with Cloud CDN, like the app files. Objects are named `tiles/{tx}/{ty}.png`, the request path; the renderer sets
  `Cache-Control: public, max-age=60` (`TILE_MAX_AGE_SECONDS`) on each one, and the CDN follows it. A tile never painted or erased
  has no object: `404`, an empty tile for the front. The front reads the version inside the PNG and ignores a raster not newer
  than the last clear (a CDN copy can outlive the clear by its max-age).
- **Clear during a render** (`renderer.js`): the session is read again after the pixels; if `clearedAt` moved in between, the render
  starts over, otherwise erased pixels could be stored with a version newer than the clear (found by the security review of #143).
- **`/get`** (`region.js`): `createRasterRegionReader` has the contract of `readRegion` of `canvas.js` (`{ x0, y0, size, clearedAt }`
  to `[{ x, y, c }]`) but reads one raster plus the new pixels per tile: at most 9 tiles for 512 x 512 not aligned on the
  grid, instead of up to ~590 000 pixel documents. `index.js` plugs it into the command store when `TILES_BUCKET` is set
  (`{ ...store, readRegion }`); without it `/get` falls back to reading Firestore. **The area** is the one of the command
  worker (`docs/discord-bot.md`): a square `size x size` (16 to 512, default 128) centred on `(x, y)`, default the centre of the
  grid where the web app opens, scaled to at least 512 px, unpainted pixels white. A whole-grid view would be an overview
  (contract, question D, not delivered): `/snapshot` shows the painted area.
- **Identities**: `fn-tile-renderer`: `datastore.user` (project, no per-collection IAM in Firestore) and `storage.objectUser` on the
  tiles bucket; the command worker gets `storage.objectViewer` on the tiles bucket; the load balancer's service agent gets
  `storage.objectViewer` on the tiles bucket (delivery). No function is reachable from the internet for the tiles, see
  `infra/serverless/README.md`, "Tile rasters".
- **PNG without a dependency**: `lib/pngDecode.js` is the counterpart of `lib/png.js` (8-bit RGB/RGBA, no interlace, the five
  filters, CRC checked, output size bounded), about 130 lines on `node:zlib`. It only reads rasters this platform wrote, so a library
  (`pngjs`: pure JavaScript, but one more dependency to audit, for a format the encoder already fixes) was not worth it.

Tests: `test/tiles` (tile and offset arithmetic, decoder and filters, version = floor of the newest `t`, raster + delta,
clear, bucket preconditions, coalescing of a burst of 60 messages into a few renders without losing a pixel, leader
loop and lease takeover, clear during a render, Cache-Control of the objects, `/get` from rasters over 9 tiles) and `test/emulator/tiles.test.js`
(the delta query and the lease transactions against the Firestore emulator).

