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
| `gateway.tf` | API Gateway (#60): gateway service account, API, config, gateway, `gateway-stub` function |
| `openapi/api.yaml.tftpl` | The OpenAPI 2.0 spec of the gateway, rendered with the function URLs |
| `frontend.tf` | Frontend bucket (private), generated `config.json`, HTTPS load balancer with Cloud CDN |
| `firestore.tf` | Firestore database, composite indexes, TTL and index overrides, security rules release |
| `firestore.rules` | Browser security rules: read-only, own documents only (tests in `tests/firestore-rules`) |
| `storage.tf` | Private `tiles` and `snapshots` buckets |
| `pubsub.tf` | Topics, consumer subscriptions and dead-letter topics (`modules/pubsub`, see `docs/pubsub.md`) |
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
- **API** (#60): `apiBase` is the URL of the API Gateway (`local.gateway_url`); `var.api_base_url` overrides it.

## API Gateway

```
browser / Discord ──HTTPS──> API Gateway (gateway_region) ──ID token of api-gateway@──> private function
                              JWT checked here                run.invoker: this account only, never allUsers
```

The gateway is the only public entry point. A function URL answers `403` to anyone but the gateway: `ingress` is
`ALLOW_ALL` (the gateway is not an internal source), and the lock is IAM, `roles/run.invoker` for
`api-gateway@<project>.iam.gserviceaccount.com` on each function (`local.gateway_invokers`). The gateway signs a
Google ID token with that account for every call (`jwt_audience` in the spec).

| Route | Authentication | Backend |
|---|---|---|
| `GET /health` | none | `health` (deploy smoke test) |
| `POST /discord/interactions` | none: the proxy verifies the Ed25519 signature | `discord-proxy` |
| `POST /auth/discord` | none: it creates the session | `auth-discord` |
| `POST /pixels`, `GET /pixels/{x}/{y}` | session JWT | proxy of #66, `gateway-stub` until then |
| `GET /tiles/{tx}/{file}` | session JWT | only with `gateway_tiles_route = true` (option 1 of open question A) |
| `OPTIONS` on the routes the browser calls | none | the same backend, which answers the CORS preflight |

- **Where the JWT is checked.** `x-google-issuer`, `x-google-audiences` (outputs `auth_jwt`) and the signature. The token
  is signed by the service account of `auth-discord` through IAM Credentials (`signJwt`), so the keys are the ones
  Google publishes for that account: `https://www.googleapis.com/robot/v1/metadata/x509/fn-auth-discord@<project>...`.
  No key of ours, nothing to rotate. The first design (own ES256 key and a JWKS served by the function) was dropped:
  the JWKS URL would be the gateway's own, which does not exist until the config that contains it does (a cycle), and
  the function cannot be public.
- **What a backend receives.** The request path appended to its URL (`/pixels/10/20`), the original `Authorization`
  moved to `X-Forwarded-Authorization`, and the verified claims, base64url-encoded JSON, in `X-Apigateway-Api-Userinfo`
  (`sub` is the Discord id): a proxy reads the user from there, it does not parse the token again.
- **CORS** is answered by the backends (the gateway only forwards `OPTIONS`); the allowed origins are those of
  `auth_discord_redirect_uris`. Each new proxy must answer its own preflight like `auth-discord` does.
- **Routes without a function yet** point to `gateway-stub` (answers `501`): the route, its JWT check and its IAM
  are live. Replace the line in `local.gateway_backends` when the function lands.
- **Region.** API Gateway is not available in `europe-west9` (prd): `gateway_region` defaults to `europe-west1`, the
  functions stay in `region`. The validation lists the supported regions.
- **Throttling.** API Gateway quotas count per consumer *project* and need an API key, so they cannot limit anonymous
  users, and a global cap would let one attacker lock everybody out. What bounds the load instead is `max_instances` on each
  function (the cost ceiling) and the business rate limit of the draw worker. Per-IP limits would need a load
  balancer with Cloud Armor in front of the gateway: not done.
- **Changing the spec.** A config is immutable: a new one is created (`create_before_destroy`), the gateway moves to
  it, the old one is deleted. Only the pipeline applies it. `deploy-env.yml` then calls `GET /health` through the gateway.
- **Adding a route.** Add the path in `openapi/api.yaml.tftpl`, its backend in `local.gateway_backends`, and put
  `local.gateway_invokers` in the `invokers` of the function.
- **Discord.** `terraform output -raw discord_interactions_url` is the Interactions Endpoint URL of the Developer
  Portal; the host of `gateway_url` is the target of the Activity mapping `/api` (`docs/discord-activity.md`).

## Adding a function

Every function is an HTTP function. A **proxy** is invoked by the API Gateway; a **worker** is invoked by the
push subscription of its channel (`pubsub.tf`), which gives it the retry policy and the dead-letter topic of
`modules/pubsub`. There is no Eventarc trigger option on purpose: it would create its own subscription, without
DLQ, outside Terraform.

```hcl
# Identity Pub/Sub uses to sign the push requests (OIDC) to the worker.
resource "google_service_account" "draw_push" {
  project      = var.project_id
  account_id   = "push-draw-worker"
  display_name = "Pub/Sub push to draw-worker"
}

module "draw_worker" {
  source = "./modules/function"

  project_id  = var.project_id
  region      = var.region
  name        = "draw-worker"
  description = "Applies pixel.draw events"
  runtime     = var.functions_runtime
  entry_point = "drawWorker" # decodes the body with decodePushMessage (src/lib)

  source_bucket            = google_storage_bucket.functions_source.name
  source_object            = google_storage_bucket_object.functions_source.name
  docker_repository        = google_artifact_registry_repository.functions.id
  build_service_account_id = google_service_account.functions_build.id

  invokers   = [google_service_account.draw_push.member] # only its subscription can call it
  secret_env = { DISCORD_BOT_TOKEN = google_secret_manager_secret.this["discord-bot-token"].secret_id }
}

# In pubsub.tf, module "pubsub":
#   push = {
#     "pixel.draw" = {
#       endpoint        = module.draw_worker.uri
#       service_account = google_service_account.draw_push.email
#     }
#   }
```

A worker answers `2xx` to ack the message. Any other status (or a timeout) makes Pub/Sub retry with backoff, then
dead-letter the message after `max_delivery_attempts`.

Each function gets its own service account `fn-<name>` (logs and trace writer, its secrets only). Grant it the
rest (publish on a topic, Firestore, a bucket) next to the resource, using `module.<fn>.service_account_email`.

## Access to Firestore and the buckets

Data model and reasoning: `docs/data-model.md`. Grant each function only what it needs, next to the resource:

```hcl
# A worker that writes Firestore. Firestore has no per-collection IAM, so this is
# a project-level role (already in DEPLOY_GRANTABLE_ROLES). Read-only: roles/datastore.viewer.
resource "google_project_iam_member" "draw_worker_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${module.draw_worker.service_account_email}"
}

# A bucket role on that bucket only, never roles/storage.* at project level.
resource "google_storage_bucket_iam_member" "tile_renderer" {
  bucket = google_storage_bucket.tiles.name
  role   = "roles/storage.objectUser" # objectViewer to read, objectCreator to only add
  member = "serviceAccount:${module.tile_renderer.service_account_email}"
}
```

Security rules never apply to these calls: they only filter the browser SDK. Changing `firestore.rules` creates a new
ruleset and re-points the `cloud.firestore` release; run `npm test` in `tests/firestore-rules` (Java 21 and Node 22)
first. After a deploy, `scripts/check-private-access.sh <project_id>` checks anonymously that the buckets and Firestore
are closed.

`(default)` must not exist before the first apply (otherwise import it). On prd the database has delete protection
and the snapshots bucket refuses `force_destroy`, so `destroy.yml` stops there until protection is lifted on purpose.

## Secrets

```sh
printf '%s' "$VALUE" | gcloud secrets versions add discord-public-key --project <project_id> --data-file=-
```

`discord-public-key`, `discord-bot-token`, `discord-oauth-client-secret`: never in tfvars.

A function cannot start while one of its secrets has no version: add them **before** the first apply that deploys it.
The session JWT needs no secret: `auth-discord` signs it as its own service account (IAM Credentials), and the gateway
verifies it with the keys Google publishes for that account (see "API Gateway"). Google rotates those keys itself.

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
