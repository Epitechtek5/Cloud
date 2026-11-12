# infra/serverless

Serverless application stack (API Gateway, functions, queues, storage), applied after `infra/foundation` by
`deploy-env.yml` (state prefix `serverless`) and destroyed before it by `destroy.yml`.

The PR plan account is read-only on the state, so `serverless/default.tfstate` must exist before the first PR plan
of each environment: `scripts/bootstrap-state-bucket.sh` creates it (already done on dev and prd).

| File | Content |
|---|---|
| `apis.tf` | Required Google APIs (never disabled on destroy) |
| `secrets.tf` | Secret Manager **containers**; values are added out of band |
| `artifacts.tf` | Function source bucket and zip, Artifact Registry repository, build service account |
| `functions.tf` | One `modules/function` instance per function |
| `outputs.tf` | `app_url` (deploy smoke test contract) and ids reused by the other issues |

## Function source

The pipeline builds `functions.zip` once (`deploy.yml`) and passes it with `TF_VAR_app_artifact_dir`; the same zip
goes to dev then prd. Without it (PR plans, destroy), the stack zips `app/functions/src` + `package.json` itself
and prints a `functions_artifact` check warning.

## Adding a function

```hcl
module "draw_worker" {
  source = "./modules/function"

  project_id  = var.project_id
  region      = var.region
  name        = "draw-worker"
  description = "Applies pixel.draw events"
  runtime     = var.functions_runtime
  entry_point = "drawWorker"

  source_bucket            = google_storage_bucket.functions_source.name
  source_object            = google_storage_bucket_object.functions_source.name
  docker_repository        = google_artifact_registry_repository.functions.id
  build_service_account_id = google_service_account.functions_build.id

  pubsub_topic = google_pubsub_topic.pixel_draw.id                       # null for HTTP
  secret_env   = { DISCORD_BOT_TOKEN = google_secret_manager_secret.this["discord-bot-token"].secret_id }
}
```

Each function gets its own service account `fn-<name>` (logs and trace writer, its secrets only). Grant it the
rest (publish on a topic, Firestore, a bucket) next to the resource, using `module.<fn>.service_account_email`.

## Secrets

```sh
printf '%s' "$VALUE" | gcloud secrets versions add discord-public-key --project <project_id> --data-file=-
```

`discord-public-key`, `discord-bot-token`, `discord-oauth-client-secret`, `jwt-signing-key`: never in tfvars.

## Deployer permissions

`roles/editor` cannot set IAM policies, and this stack creates IAM bindings. `scripts/bootstrap-wif.sh` gives the
deploy service account (`gha-deploy`) two extra roles, on purpose narrower than `roles/iam.securityAdmin`:

- `roles/resourcemanager.projectIamAdmin` with a condition: it may only grant or revoke the roles of
  `DEPLOY_GRANTABLE_ROLES`, so it can never give itself `roles/owner`.
- The custom role `ghaDeployIamBindings`: `get/setIamPolicy` on secrets, Cloud Run services, Artifact Registry
  repositories, buckets, Pub/Sub topics and subscriptions, and service accounts.

A new **project-level** role in a stack (for example `roles/datastore.user`) must first be added to
`DEPLOY_GRANTABLE_ROLES`, then the script re-run on dev and prd, otherwise the apply fails with `403`. Prefer a
binding on the resource itself (topic, secret, bucket), which needs no change. Never add `owner`, `editor`, an
`*Admin` role or `iam.serviceAccountTokenCreator` to that list.
