# Pub/Sub: topics, subscriptions and dead-letter topics

Terraform module: `infra/serverless/modules/pubsub` (Terraform only, no console changes).
The module has no provider/backend: the `infra/serverless` stack calls it in `infra/serverless/pubsub.tf`,
where each proxy and worker issue adds its own entries.

```hcl
module "pubsub" {
  source     = "./modules/pubsub"
  project_id = var.project_id

  publishers = {
    "pixel.draw" = [module.draw_proxy.service_account_email] # only this function publishes here
  }

  # filled in once the workers exist; until then the subscriptions are pull ones
  push = {
    "pixel.draw" = {
      endpoint        = module.draw_worker.uri
      service_account = google_service_account.draw_push.email # also in the worker's invokers
    }
  }
}
```

## Channels

| Topic | Published by | Consumer | ack deadline | Max attempts |
|---|---|---|---|---|
| `discord.command` | Discord proxy | command worker | 60 s | 5 |
| `pixel.draw` | draw proxy | draw worker | 30 s | 5 |
| `pixel.processed` | draw worker | real-time fan-out | 30 s | 5 |
| `snapshot.requested` | command worker | snapshot worker | 300 s | 5 |

`snapshot.ready` is the GCS object event of the snapshot bucket, not a Pub/Sub topic.
One subscription per consumer: `<topic>.sub`. Each channel also has `<topic>.dlq` and a
pull subscription `<topic>.dlq.sub` to inspect and replay failed messages.

## Retention and retry (all channels)

| Setting | Value | Why |
|---|---|---|
| Topic and subscription retention | 7 days | time to process, replay and debug |
| DLQ retention | 14 days | time to investigate before messages expire |
| Retry policy | exponential backoff, 10 s to 600 s | absorbs transient failures without hammering the worker |
| `max_delivery_attempts` | 5 (Pub/Sub range: 5-100) | after 5 failures the message goes to the DLQ instead of blocking the pipeline |

## Delivery

Push to the worker (Cloud Run function) with an OIDC token minted for a dedicated push service
account; that account is the only one granted `run.invoker` on the worker, so the function is
never publicly invocable. Without a `push` entry the subscription is a pull one.

Workers are HTTP functions (`modules/function`, which has no Eventarc trigger option on purpose: Eventarc would
create its own subscription, without the retry policy and the dead-letter topic above). Full example in
`infra/serverless/README.md`.

## IAM

- A publisher gets `roles/pubsub.publisher` on **its** topic only (never at project level).
- The Pub/Sub service agent gets publisher on each DLQ topic and subscriber on each source subscription.

## Message schema

Payload: JSON (UTF-8). Attributes (strings) on every message:

| Attribute | Meaning |
|---|---|
| `correlation_id` | created by the proxy (or taken from `X-Correlation-Id`) and re-emitted by every worker |
| `event_type` | e.g. `pixel.draw`, `discord.command`, `pixel.processed`, `snapshot.requested` |
| `source` | name of the publishing function |

The JSON body of each event type is defined and validated by the shared runtime library
(`app/functions/src/lib/events.js`, see [functions.md](functions.md)): the publisher refuses an invalid event and
the worker refuses (and logs) an invalid one.

## Tests

- Plan-level (mocked provider, no GCP): `cd infra/serverless/modules/pubsub && terraform init -backend=false && terraform test`
  (runs in `ci-terraform`). It checks topics/DLQs/policies, push OIDC, per-topic publishers and service agent IAM.
- End to end on a deployed environment: `scripts/test-pubsub-dlq.sh <project_id> [channel]` publishes a
  message, never acks it and checks it reaches `<topic>.dlq.sub` after `max_delivery_attempts`. It refuses to
  run on a push subscription (it would steal messages from a real worker).
