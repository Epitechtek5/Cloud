# Observability of the serverless application

Subject 04, C08. The cluster and runners have their own dashboard (#72); this page covers the serverless app.

## Application dashboard (#73)

Dashboard as code: `infra/serverless/modules/dashboard`, instantiated in `infra/serverless/monitoring.tf` and applied
by the pipeline with the rest of the stack, so dev and prd each have one ("Pixel canvas · serverless application
(<env>)"). Its URL is the `app_dashboard_url` output. Never edit it in the console: the next apply overwrites it.

| Row | Charts | What to look for |
| --- | --- | --- |
| Functions (Cloud Run) | requests/s, 5xx/s, latency p50/p95/p99, instances, max concurrency, 429 (max instances reached) per function | a burst = requests and instances rising together; 429 = the cost ceiling (`max_instances`) is hit |
| Queues | backlog (`num_undelivered_messages`), oldest unacked age, push ack latency p95, push responses by class, per subscription | a backlog that rises then drains is normal under load; one that keeps growing means the worker is too slow or failing |
| DLQ | messages waiting in each `<channel>.dlq.sub`, messages dead-lettered per minute | anything above 0 is a message that failed 5 times: inspect it (below) |
| API Gateway | requests by response class, latency p50/p95/p99 | 4xx are mostly expired JWTs (401) or invalid batches (400) |
| Firestore, buckets | reads/writes/deletes per second, API errors by code, bucket operations | writes follow accepted pixels; `ABORTED` errors are contended transactions |
| Application | draw batches by outcome, rejected batches by user, function errors, refused admin commands | log-based metrics below |

### Log-based metrics (`monitoring.tf`)

| Metric | Source log line | Labels |
| --- | --- | --- |
| `draw_batches` | draw worker `batch applied` | `reason`: empty (all accepted), `rate_limited`, `paused` |
| `draw_rejected_batches` | same, with a rejection | `user_id` (who hits the rate limit) |
| `admin_refusals` | command worker `admin command refused` | none |
| `function_errors` | any `ERROR` line of an application function | none (chart grouped by function) |

They rely on the structured logs of `app/functions/src/lib/logger.js` (`jsonPayload.message`, `reason`, `user_id`):
renaming one of these messages breaks its metric.

### Demo

1. **Brush burst**: draw with the brush in the web app (or the load test of #76). Within a minute: requests and
   instances of `draw-proxy` and `draw-worker` rise, the `pixel.draw.sub` backlog rises then drains, Firestore writes
   follow, and `draw_batches` shows `rate_limited` once a user passes 20 pixels per minute.
2. **Forced failure**: `scripts/demo-dlq-failure.sh <project_id> [channel]` publishes a broken message. The worker
   answers `400` five times (visible in *function errors* and *push responses* `4xx`), then the message lands in
   `<channel>.dlq.sub` and shows in the **DLQ** row. Inspect it with
   `gcloud pubsub subscriptions pull <channel>.dlq.sub --limit 5`; add `--auto-ack` to clear it.

### Checks

- `terraform test` in `infra/serverless/modules/dashboard` (mocked provider, run by `ci-terraform`): every row is
  present, the DLQ widget watches every dead-letter subscription, the metrics the issue asks for are queried, p99 is
  shown, tiles do not overlap.
- The rendered dashboard JSON was checked against the Monitoring API with `validateOnly=true` (nothing created).

## End-to-end tracing (#74)

Each function starts the OpenTelemetry SDK on Cloud Run (`app/functions/src/lib/otel.js`) and exports its spans to
**Cloud Trace**. The function service accounts already have `roles/cloudtrace.agent` (module `function`). Spans are
created with the OpenTelemetry API only (`src/lib/trace.js`): without the SDK (tests, local runs) they are no-ops.

One user action is **one trace**:

```
POST /pixels (draw-proxy, SERVER, child of the gateway's traceparent / X-Cloud-Trace-Context)
└─ pixel.draw publish (PRODUCER)          traceparent copied into the Pub/Sub message attributes
   └─ pixel.draw process (draw-worker, CONSUMER)
      ├─ firestore transaction draw (CLIENT)
      └─ pixel.processed publish (PRODUCER)

POST /discord/interactions (discord-proxy) → discord.command publish → discord.command process (command-worker)
   → [/draw] pixel.draw publish → pixel.draw process → discord PATCH webhook (CLIENT)
   → [/snapshot] snapshot.requested publish → snapshot.requested process (snapshot-worker)
        → firestore stream pixels, gcs upload snapshot
        → snapshot.ready process (snapshot-notifier, parent carried in the object metadata)
             → iam signBlob (V4 signed URL), discord PATCH webhook
```

- **Propagation**: W3C `traceparent` / `tracestate` (and Google's `X-Cloud-Trace-Context` on input). The publisher
  injects them into the message attributes, `createPushHandler` extracts them. The snapshot notifier is triggered by
  the bucket, so the worker writes them into the object's custom metadata.
- **Sampling**: every new trace is kept, and so is every child of a sampled parent. A child of an *unsampled* parent
  (Cloud Run samples few incoming requests) is kept with `TRACE_SAMPLE_RATIO`, 1 by default, so that any `/draw` or
  brush stroke can be followed during the demo. Lower it on prd if the Trace quota matters. `OTEL_SDK_DISABLED=true`
  turns tracing off.
- **Export**: batched, and flushed **before the response leaves**: a worker flushes before it acks its message, and the
  HTTP entry points (`tracedHttp`) hold `res.end` until their SERVER span is exported. With request-only CPU (the Cloud
  Run default) an instance gets no CPU once it has answered, so a flush after the response would stay frozen until the
  next request. Also flushed on `SIGTERM`. A failing exporter never fails a request.
- **No secrets in spans**: the Discord interaction token is in the webhook URL, which is never recorded (method and
  status only).

### Logs ↔ traces

Every log line of a request carries `trace_id`, `span_id`, `trace_sampled` and `logging.googleapis.com/trace`, taken
from the active span. In Logs Explorer, *Show entries for this trace* lists the lines of every function involved, and
Cloud Trace shows the lines under each span.

### Logs Explorer queries

Saved queries need `logging.queries.share`, which only `roles/logging.admin` holds; the deployer does not get that
role. These queries are therefore kept here: paste them, then *Save* them as shared queries from the console.

| Purpose | Query |
| --- | --- |
| Everything about one request (`X-Correlation-Id` of the response, or `correlation_id` of a span) | `jsonPayload.correlation_id="<id>"` |
| One trace, every function | `trace="projects/<project_id>/traces/<trace_id>"` |
| Errors of the application | `resource.type="cloud_run_revision" severity>=ERROR jsonPayload.function:*` |
| Messages failing (retried, then dead-lettered) | `jsonPayload.message="processing failed, the message will be retried"` |
| Rate-limited users | `jsonPayload.message="batch applied" jsonPayload.reason="rate_limited"` |
| Refused admin commands | `jsonPayload.message="admin command refused"` |
| One user's activity | `jsonPayload.user_id="<discord id>"` |

### Demo

1. Draw a pixel with `/draw` (or the brush) and copy the `X-Correlation-Id` from the response or a log line.
2. Logs Explorer → `jsonPayload.correlation_id="<id>"` → open a line → *View trace details*.
3. The waterfall shows the proxy, the publish, the queue wait (gap between publish and process), the worker, its
   Firestore transaction and the Discord answer, all in one trace.

### Checks

`test/lib/trace.test.js` runs an in-memory SDK: a brush stroke and a `/draw` each produce a single trace with the
expected parent → child chain, logs carry the trace, a failing worker records the exception on its span, and the
Discord token never reaches a span attribute. `test/lib/otel.test.js` covers the SDK start (service name, sampling of
unsampled parents, flush).
