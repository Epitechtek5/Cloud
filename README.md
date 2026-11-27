# Cloud: collaborative pixel canvas on GCP

A shared 100 000 × 100 000 pixel canvas, like r/place, driven by a **Discord bot** (slash commands) and a **real-time web
app** (also a Discord Activity). Everything runs serverless on Google Cloud, is created by Terraform through a CI/CD
pipeline, and is observable (dashboards, structured logs, traces, alerts). Epitech Cloud Native project.

- **Discord**: `/draw x y color`, `/get x y size` (PNG of an area), `/snapshot` (PNG of the canvas, signed URL),
  `/admin pause | resume | clear | ratelimit`. 20 pixels per minute and per user by default.
- **Web app**: login with Discord (`identify` scope only), pan and zoom over the whole grid, brush of configurable size,
  inspection of a pixel (colour, author, date), updates in real time with **no polling**.
- **No write to storage from the browser**: every pixel goes through the API gateway, a proxy, a queue and a worker.

The architecture diagram, and how it is kept true to what is deployed, are in [`docs/architecture.md`](docs/architecture.md).

## How it works

```
 Discord ──▶ discord-proxy ──┐                                  ┌──▶ Firestore  (pixels, quotas, session)
                             ├─ Pub/Sub ──▶ workers (commands,  ┤
 Browser ──▶ API Gateway ────┘   queues     draw, snapshot)     └──▶ Cloud Storage (tile rasters, snapshots)
    ▲            └─▶ auth-discord (login, session JWT)                    │
    └──────── Firestore listeners (real time) + tile PNGs behind CDN ◀───┘
```

Proxies only authenticate, acknowledge and publish; workers apply the rules (pause, rate limit, idempotent writes) and
scale on the backlog; no function is reachable without the gateway. The grid is split into 256 × 256 **tiles**: one
Firestore document per painted pixel with its tile, one PNG raster per tile, and the browser loads the raster of a tile
then listens only to the pixels newer than it.

## Repository layout

| Path | Content | Documentation |
| --- | --- | --- |
| `app/frontend` | Web app and Discord Activity (Vite, TypeScript, Canvas 2D) | [`app/frontend/README.md`](app/frontend/README.md), [`docs/frontend.md`](docs/frontend.md) |
| `app/functions` | Cloud Run functions (proxies and workers), Node.js 22 | [`docs/functions.md`](docs/functions.md) |
| `infra/serverless` | The application as Terraform: functions, gateway, Pub/Sub, Firestore, buckets, front hosting, dashboards | [`infra/serverless/README.md`](infra/serverless/README.md) |
| `infra/foundation` | VPC, private GKE cluster and the self-hosted runners (ARC) | [`docs/infra.md`](docs/infra.md) |
| `infra/access` | Workload Identity Federation, pipeline identities, team and instructor access | [`infra/access/README.md`](infra/access/README.md) |
| `infra/billing` | Monthly budget and cost alerts | [`infra/billing/README.md`](infra/billing/README.md) |
| `k8s/runners` | Helm values of the runner controller and scale set | [`docs/ci/self-hosted-runners.md`](docs/ci/self-hosted-runners.md) |
| `.github/workflows` | CI, release, deploy, destroy | [`docs/infra.md`](docs/infra.md), [`docs/ci/`](docs/ci) |
| `scripts` | Bootstrap, checks and demo scripts | header of each script |
| `docs` | All the documentation | [`docs/README.md`](docs/README.md) |

Two GCP projects, one per environment (`dev`, `prd`), with the same Terraform code and a `<env>.tfvars` each. `dev` is
deployed on every merge into the `dev` branch, `prd` on every release tag, behind required reviewers.

## Run it locally

```sh
cd app/frontend && npm ci && npm run dev      # the app with an in-browser mock backend, no cloud needed
cd app/functions && npm ci && npm test        # unit tests of the functions (the emulator tests need Java 21: npm run test:emulator)
```

## Bootstrap a new environment

You need **Owner** on the GCP project, `gcloud`, `terraform` (>= 1.9) and the GitHub CLI. Once per environment:

1. Create the state bucket: `scripts/bootstrap-state-bucket.sh <project_id> huiledecloud-<env>-tfstate`.
2. Apply `infra/access` (identities, WIF, people) and publish the GitHub variables; the commands and the
   `local.tfvars` to fill in are in [`infra/access/README.md`](infra/access/README.md) ("Apply", "New project").
3. Add the values of the Discord secrets (`discord-public-key`, `discord-bot-token`, `discord-oauth-client-secret`); a
   function cannot start while its secret has no version
   ([`infra/serverless/README.md`](infra/serverless/README.md), "Secrets").
4. Apply `infra/billing` for the budget ([`infra/billing/README.md`](infra/billing/README.md)).

Everything else is applied by the pipeline: a first deploy takes about 15 minutes, and the managed certificate of the
front can take up to an hour to become active ([`docs/reproducibility.md`](docs/reproducibility.md)).

## Deploy

GitFlow, squash merges, signed commits, Conventional Commit titles (they feed semantic-release):

1. A short-lived `feature/*` branch, a pull request into `dev`: `ci-gate` waits for the CI that applies (tests, audit,
   Terraform validate and plans for both environments, gitleaks), and a review is required.
2. Merge into `dev`: `deploy` builds the functions and the front once and applies them to **dev**.
3. A release PR from `dev` into `main`; the merge makes `release` create the `vX.Y.Z` tag.
4. The tag triggers `deploy` on **prd**, after approval by a required reviewer, then the smoke tests and the
   architecture diagram are regenerated.

Details: [`docs/ci/release.md`](docs/ci/release.md), [`docs/ci/branch-protection.md`](docs/ci/branch-protection.md).

## Destroy

`destroy` removes everything billable of an environment and checks that nothing is left; the access stack, the budgets,
the state bucket, the front IP and the secret containers stay on purpose:

```sh
gh workflow run destroy.yml --ref dev -f env=dev -f confirm=destroy-dev
```

While dev is destroyed the PR checks cannot use the self-hosted runners: set `CI_RUNNER` back to `ubuntu-latest`
([`docs/reproducibility.md`](docs/reproducibility.md)).

## Documentation

Start with [`docs/README.md`](docs/README.md): the map of every document by track, the security summary, the
justification of every third-party component ([`docs/open-source.md`](docs/open-source.md)) and the defense runbook
([`docs/defense.md`](docs/defense.md)).
