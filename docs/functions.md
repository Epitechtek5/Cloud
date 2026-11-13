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
  src/lib/            shared runtime library (below)
  test/               node:test unit tests (test/lib for the library)
```

- **Build and test**: `ci-functions.yml` runs `npm run lint`, `npm run test:coverage` (fails under 90 % lines,
  80 % branches, 90 % functions of `src`), `npm run build` and zips `dist/`.
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
