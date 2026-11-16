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
