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

## Functions at a glance

Every function is a Cloud Run function (2nd gen, Node 22) with **its own service account** holding only what it
needs, `roles/logging.logWriter` and `roles/cloudtrace.agent` (module `infra/serverless/modules/function`). None is
public: the HTTP ones only accept the API Gateway service account (`roles/run.invoker`), the workers only accept the
OIDC identity of their own push subscription and are `ALLOW_INTERNAL_ONLY`.

| Function | Entry point | Trigger | Data access | Timeout / max instances | Doc |
| --- | --- | --- | --- | --- | --- |
| `discord-proxy` | `discordProxy` | `POST /discord/interactions` (gateway) | reads the `discord-public-key` secret, publishes `discord.command` | 10 s / 5 | `discord-bot.md` |
| `command-worker` | `commandWorker` | push `discord.command.sub` | Firestore read/write (`datastore.user`), publishes `pixel.draw`, `pixel.processed`, `snapshot.requested`, answers Discord | 55 s / 5 | `discord-bot.md` |
| `draw-proxy` | `drawProxy` | `POST /pixels` (gateway, Firebase JWT) | publishes `pixel.draw` only, no Firestore | 10 s / 10 | below |
| `pixel-reader` | `pixelReader` | `GET /pixels/{x}/{y}` (gateway, Firebase JWT) | Firestore read only (`datastore.viewer`) | 10 s / 5 | below |
| `draw-worker` | `drawWorker` | push `pixel.draw.sub` | Firestore read/write, the **only writer of the grid**; publishes `pixel.processed` | 25 s / 10 | below |
| `snapshot-worker` | `snapshotWorker` | push `snapshot.requested.sub` | Firestore read, create-only on the snapshots bucket (`objectCreator`) | 290 s, 1 GiB / 2 | below |
| `snapshot-notifier` | `snapshotNotifier` | bucket notification → `snapshot.ready` → push | reads the object, signs URLs (`signBlob` on itself only), answers Discord | 30 s / 2 | below |
| `auth-discord` | `authDiscord` | `POST /auth/discord` (gateway) | Discord OAuth2 secret, mints Firebase custom tokens (`signJwt` on itself only) | 20 s / 3 | `discord-activity.md` |
| `health` | `hello` | `GET /health` (gateway) | none | 60 s / 1 | |
| `gateway-stub` | `notImplemented` | routes whose function does not exist yet | none | 60 s / 1 | |

`max_instances` is the cost ceiling: beyond it Cloud Run answers 429, Pub/Sub retries with backoff and the backlog
absorbs the burst (visible on the dashboard, `docs/observability.md`).

## Design choices to defend

| Choice | Why | Where |
| --- | --- | --- |
| **Proxy + queue + worker** for every write | The proxy answers in milliseconds (Discord requires 3 s, the web wants a fast 202); the worker scales on its own, retries, and dead-letters what keeps failing. A burst of brush strokes becomes a backlog, not errors | `pubsub.md` |
| **Push subscriptions** (not pull) | Scale to zero: no instance polls an empty queue. Each push is OIDC-signed by a dedicated identity, the only invoker of its worker | `infra/serverless/pubsub.tf` |
| **At-least-once + idempotency markers** | Pub/Sub redelivers. `processedCommands/{interaction}` and `processedBatches/{batch}` are written **in the same transaction** as the effect, so a redelivery changes nothing and replays the stored outcome (quota counted once) | `data-model.md` §6 |
| **One document per pixel**, `tile` field, 256×256 tiles | 10¹⁰ cells can't be one document or one array. A pixel written whole is never half from one draw and half from another (last write wins on the server timestamp). Tiles give the front one listener per visible square | `data-model.md` |
| **Clear = new generation** (`clearedAt` + `epoch`) | Deleting up to 10¹⁰ documents is neither fast nor cheap. Pixels older than `clearedAt` count as erased everywhere | `discord-bot.md` |
| **Rate limit in the transaction** (fixed 60 s window, 20 px default, per-user override) | Read and written with the pixels, so concurrent batches of one user can never exceed the limit; partial acceptance keeps the first pixels of a stroke | `src/draw/rules.js` |
| **Admin = configured role/user ids**, fail closed | The Discord permission bitfield is the guild's, not ours; an empty list means nobody is admin | `src/commands/authorize.js` |
| **Snapshots through the bucket** (create-only object, notification, signed URL) | The PNG can take seconds; the worker never holds the Discord answer. Create-only (`ifGenerationMatch: 0`) makes a redelivery a no-op, and the bucket stays private: the user gets a V4 URL valid `snapshot_url_ttl_seconds` | below |
| **Structured logs + correlation id + traces** | One id from the gateway to the last worker, in logs and spans: a request is followed end to end | `observability.md` |
| **No framework, few dependencies** | Google client libraries and OpenTelemetry only; the PNG encoder uses `node:zlib`. Less attack surface, fast cold starts | `open-source-functions.md` |

## Shared library (`src/lib`)

| Module | What it gives |
| --- | --- |
| `logger.js` | `createLogger(fields)`: one JSON line per entry on stdout (stderr from `ERROR`), with `severity`, `message`, `function`, `event_type`, `correlation_id`, `trace_id`, `span_id`, `user_id`, and `logging.googleapis.com/trace` so that Cloud Logging attaches the entry to its trace. `LOG_LEVEL` filters (`WARN` is accepted for `WARNING`, an unknown value falls back to `INFO`); fields never override `severity` or `message`. |
| `trace.js` | Spans on the OpenTelemetry API: `withSpan`, `firestoreSpan`, `tracedHttp` (SERVER span of an HTTP entry point), `injectContext` / `extractContext` (W3C `traceparent` in Pub/Sub attributes), `activeTraceIds` (for the logs), `flushSpans`. No-ops without the SDK. See `docs/observability.md`. |
| `otel.js` | `startOtel()`: OpenTelemetry SDK, Cloud Trace exporter, W3C + `X-Cloud-Trace-Context` propagation, sampling (`TRACE_SAMPLE_RATIO`). Started by `src/index.js` on Cloud Run only (`OTEL_SDK_DISABLED=true` turns it off). |
| `correlation.js` | `correlationFromHeaders` (`X-Correlation-Id` if safe, a new UUID otherwise), `correlationFromAttributes` (`correlation_id` of a message), `traceFromHeaders` (`traceparent` or `X-Cloud-Trace-Context`). |
| `context.js` | `httpContext(req)` for proxies and `messageContext(attributes)` for workers: correlation id, trace and a logger bound to both. |
| `events.js` | Schemas of `discord.command`, `pixel.draw`, `pixel.processed`, `snapshot.requested`, with `validateEvent` / `assertEvent`. Grid `0..99999`, colour `0..0xFFFFFF`, 1 to 256 pixels per batch (also the cap of `pixel.processed`). `/admin clear` is `pixel.processed` with `cleared: true` and no pixels, never per-pixel deltas. Unknown fields, prototype keys included, are refused. |
| `publisher.js` | `createPublisher({ source })`: validates the event, publishes it as JSON on the topic named after its type, with the `correlation_id`, `event_type` and `source` attributes. |
| `pubsubPush.js` | `decodePushMessage(body, { expect })`: decodes and validates a Pub/Sub push request on the worker side; `expect` refuses any event type the worker does not handle. |
| `secrets.js` | `createSecretReader()`: Secret Manager access, cached in memory per instance (one call per secret, failures not cached, including a failed client import). |
| `worker.js` | `createPushHandler({ expect, handle })`: HTTP plumbing of a push worker. `204` acks, `400` for a broken message (retries then DLQ), `500` when `handle` throws (retried). |
| `firestore.js` | `getFirestore()`: lazy Firestore client (emulator when `FIRESTORE_EMULATOR_HOST` is set), `toMillis`. |
| `grid.js` | Tiles (`tileOf`, `tilesOfRect`, 256x256), `pixelId`, `inGrid`, collection names. |
| `canvas.js` | `readSession` (`paused`, `clearedAt`), `readRegion` (pixels of a square, newer than the last clear, on the `(tile, t)` index, at most 100 000 documents read, `truncated` past that), `renderRegion` (RGBA, scaled). |
| `png.js` | `encodePng(width, height, rgba)`: PNG encoder on `node:zlib`, no image dependency. |
| `storage.js` | `getStorage()`: lazy Cloud Storage client. |
| `discordWebhook.js` | `createInteractionClient()`: `editOriginal` / `followUp` of an interaction (JSON or multipart with files), errors flagged `retryable`. |
| `snowflake.js` | `snowflakeTime(id)`: creation time of a Discord id. |
| `tracing.js` | `registerTracingHook` / `initTracing()`: runs the OpenTelemetry bootstrap (`otel.js`) once per instance; a failed start is retried by the next call. |

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

1. reads `processedBatches/{uid}_{batchId}`, `session/state` and `users/{uid}`; a batch whose marker exists is not
   applied again (its stored outcome is replayed: `pixel.processed` again, same Discord answer);
2. `rules.js` decides: everything rejected (`paused`) while paused; otherwise a **fixed window** of 60 s,
   `limit = users/{uid}.override ?? DEFAULT_RATE_LIMIT` (20), and a batch over the quota is **partially accepted**
   (the first pixels, duplicates within a batch counted once, last colour wins);
3. writes each accepted pixel whole, `{x, y, tile, c, a, an, t: serverTimestamp}` (last write wins by server
   time, never a mix of two draws), the quota `{limit, used, windowStart}`, the rejected pixels in
   `userEvents/{uid}_{batchId}` (`reason`, `pixels`, TTL 1 h) and the marker (TTL 8 days).

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
  `MAX_SNAPSHOT_PIXELS` (2 million) are kept and at most `MAX_SNAPSHOT_READS` (2 million) documents are read, erased
  ones included, so a snapshot ends within the timeout; past either bound the snapshot is flagged `truncated` and the
  Discord message says part of the drawings is missing.
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

