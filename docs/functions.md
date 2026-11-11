# Functions: layout and shared runtime library

`app/functions` holds every Cloud Run function of the platform. Each function does one thing (SRP, subject 3.1),
and they all share the same plumbing in `src/lib` (C05 §6, C08 §6).

## Layout

```
app/functions/
  package.json        one package, one artifact (functions.zip) for every function
  src/index.js        exports every entry point; Terraform picks one per function (entry_point)
  src/<function>/     code of one function (proxy or worker), thin, built on src/lib
  src/lib/            shared runtime library (below)
  test/               node:test unit tests (test/lib for the library)
```

- **Build and test**: `ci-functions.yml` runs `npm run lint`, `npm run test:coverage` (fails under 90 % lines,
  80 % branches, 90 % functions of `src/lib`), `npm run build` and zips `dist/`.
- **Packaging**: `deploy.yml` builds the same `functions.zip` once and passes it to Terraform
  (`app_artifact_dir`); each `google_cloudfunctions2_function` uses it with its own `entry_point` and its own
  service account.

## Shared library (`src/lib`)

| Module | What it gives |
| --- | --- |
| `logger.js` | `createLogger(fields)`: one JSON line per entry on stdout (stderr from `ERROR`), with `severity`, `message`, `function`, `event_type`, `correlation_id`, `trace_id`, `span_id`, `user_id`, and `logging.googleapis.com/trace` so that Cloud Logging attaches the entry to its trace. `LOG_LEVEL` filters. |
| `correlation.js` | `correlationFromHeaders` (`X-Correlation-Id` if safe, a new UUID otherwise), `correlationFromAttributes` (`correlation_id` of a message), `traceFromHeaders` (`traceparent` or `X-Cloud-Trace-Context`). |
| `context.js` | `httpContext(req)` for proxies and `messageContext(attributes)` for workers: correlation id, trace and a logger bound to both. |
| `events.js` | Schemas of `discord.command`, `pixel.draw`, `pixel.processed`, `snapshot.requested`, with `validateEvent` / `assertEvent`. Grid `0..99999`, colour `0..0xFFFFFF` (`-1` = cleared in `pixel.processed`), 1 to 256 pixels per batch. |
| `publisher.js` | `createPublisher({ source })`: validates the event, publishes it as JSON on the topic named after its type, with the `correlation_id`, `event_type` and `source` attributes. |
| `pubsubPush.js` | `decodePushMessage(body)`: decodes and validates a Pub/Sub push request on the worker side. |
| `secrets.js` | `createSecretReader()`: Secret Manager access, cached in memory per instance (one call per secret, failures not cached). |
| `tracing.js` | `initTracing()` hook, a no-op until the tracing issue registers the OpenTelemetry bootstrap. |

## Correlation id, end to end

```
client --X-Correlation-Id--> proxy: httpContext(req) -> log + publish(..., { correlationId })
        Pub/Sub message attribute correlation_id
worker: decodePushMessage(body) -> messageContext(attributes) -> log (same correlation_id)
```

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
