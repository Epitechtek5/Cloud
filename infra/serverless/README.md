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
| `auth_discord.tf` | `POST /auth/discord` (#67) with its variables and outputs |
| `frontend.tf` | Frontend bucket (private), generated `config.json`, HTTPS load balancer with Cloud CDN |
| `outputs.tf` | `app_url` (deploy smoke test contract) and ids reused by the other issues |

## Function source

The pipeline builds `functions.zip` once (`deploy.yml`) and passes it with `TF_VAR_app_artifact_dir`; the same zip
goes to dev then prd. Without it (PR plans, destroy), the stack zips `app/functions/src` + `package.json` itself
and prints a `functions_artifact` check warning.

The zip is already built (the content of `dist/`, no `src/`). Cloud Build would still run `npm run build` because
`package.json` has a `build` script, and fail on the missing `src/`: the empty `gcp-build` script in
`app/functions/package.json` tells it to only install the production dependencies. Do not remove it.

## Frontend hosting

```
browser / Discord proxy ──HTTPS──> global external Application LB (managed cert, TLS 1.2+)
                                    ├─ :80  -> 301 to https
                                    └─ :443 -> Cloud CDN -> backend bucket -> <project>-frontend (private)
```

- **Same artifact everywhere**: `deploy.yml` builds `app/frontend` once; the stack uploads
  `${app_artifact_dir}/frontend/**` and writes `config.json` next to it from the tfvars of the environment
  (`env`, `apiBase`, `discordClientId`, Firebase config; format in `app/frontend/src/runtimeConfig.ts`).
  PR plans and destroy have no artifact: nothing is uploaded and the `frontend_artifact` check warns (a PR plan
  therefore shows the frontend objects removed). A local plan uses `app/frontend/dist` if it was built.
- **Private bucket**: `public_access_prevention = "enforced"`; only the load balancer service agent
  `service-<project number>@https-lb.iam.gserviceaccount.com` has `roles/storage.objectViewer` on it
  ([private bucket access](https://cloud.google.com/cdn/docs/setting-up-cdn-with-bucket#enable_private_bucket_access)).
  That agent exists once the project has a backend bucket, hence the `depends_on`.
- **Cache**: the CDN follows each object's `Cache-Control` (`USE_ORIGIN_HEADERS`): one year, `immutable`, for
  the hashed `assets/**`; `no-cache` for `index.html` and `config.json`. A deploy needs no invalidation.
- **`/`** is rewritten to `/index.html` by the URL map (a bucket has no index page); the query is kept, which the
  OAuth callback (`?code=&state=`) and the Activity (`?frame_id=`) need.
- **Domain**: a Google-managed certificate needs a domain whose A record points to the load balancer. Without
  `frontend_domain`, the stack uses `<a-b-c-d>.sslip.io` (a public DNS that resolves to the IP written in the
  name). To use a real domain, set `frontend_domain` in the tfvars and create an A record to the `frontend_ip`
  output; the certificate is replaced (create before destroy).
- **First deploy of an environment**: the certificate takes up to about an hour to become `ACTIVE`; until then
  HTTPS fails and the smoke test may be red. Re-run the deploy job once
  `gcloud compute ssl-certificates list` shows `ACTIVE`.
- **The IP is the identity**: `destroy.yml` releases the address, so after a destroy and redeploy the sslip.io
  host changes, and so do the Discord OAuth2 redirect and the Activity `/` mapping
  ([docs/discord-activity.md](../../docs/discord-activity.md) §1).
- **Tiles** (open question A, #68): `local.frontend_tiles_backend` adds a `/tiles/*` route to a backend service
  (serverless NEG of the tile-reader, ingress `internal-and-cloud-load-balancing`) on the same origin and CDN.
- **API** (#60): `local.frontend_api_base` takes `var.api_base_url` (empty) until the gateway URL is wired there.

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

A function cannot start while one of its secrets has no version: add them **before** the first apply that deploys it.
`jwt-signing-key` is an EC P-256 private key (PEM), generated straight into Secret Manager, never written to disk:

```sh
openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt |
  gcloud secrets versions add jwt-signing-key --project <project_id> --data-file=-
```

The gateway verifies the session JWT with the public half, served by `auth-discord` on `GET` (JWKS). A new version
is read by new instances only, so rotate the key by adding a version **then** deploying a new revision (next
release); sessions signed with the old key (10 min at most) are then rejected and users log in again.

## Deployer permissions

`roles/editor` cannot set IAM policies, and this stack creates IAM bindings. `infra/access` gives the deploy
service account (`gha-deploy`) two extra roles, on purpose narrower than `roles/iam.securityAdmin`:

- `roles/resourcemanager.projectIamAdmin` with a condition: it may only grant or revoke the roles of
  `deploy_grantable_roles` (`infra/access/roles.tf`), so it can never give itself `roles/owner`.
- The custom role `ghaDeployIamBindings`: `get/setIamPolicy` on secrets, Cloud Run services, Artifact Registry
  repositories, buckets, Pub/Sub topics and subscriptions, and service accounts.

A new **project-level** role in a stack (for example `roles/datastore.user`) must first be added to
`deploy_grantable_roles`, then `infra/access` applied on dev and prd, otherwise the apply fails with `403`. Prefer a
binding on the resource itself (topic, secret, bucket), which needs no change. Never add `owner`, `editor`, an
`*Admin` role or `iam.serviceAccountTokenCreator` to that list.
