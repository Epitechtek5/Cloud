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
| `canvas.js` | `readSession` (`paused`, `clearedAt`), `readRegion` (pixels of a square, newer than the last clear, on the `(tile, t)` index, at most 100 000 documents read, `truncated` past that), `renderRegion` (RGBA, scaled). |
| `png.js` | `encodePng(width, height, rgba)`: PNG encoder on `node:zlib`, no image dependency. |
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

