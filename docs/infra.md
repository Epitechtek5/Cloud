# Infrastructure track: foundation, access and CI/CD

Subject 02 and 5.6, issue #80. What the infra track deploys, how it is deployed, and the choices to defend. Details
live next to the code; this page is the map:

| Topic | Detailed doc |
| --- | --- |
| Human access, WIF, pipeline identities and their roles | [`infra/access/README.md`](../infra/access/README.md) |
| Budgets and cost alerts | [`infra/billing/README.md`](../infra/billing/README.md) |
| Self-hosted runners (ARC on GKE), install and operation | [`docs/ci/self-hosted-runners.md`](ci/self-hosted-runners.md) |
| Runner selection and guardrails | [`docs/ci/runner-guardrails.md`](ci/runner-guardrails.md) |
| Branch protection and the `ci-gate` check | [`docs/ci/branch-protection.md`](ci/branch-protection.md) |
| Releases (semantic-release) | [`docs/ci/release.md`](ci/release.md) |
| Secret scanning and SAST | [`docs/ci/security.md`](ci/security.md) |
| Reproducible and disposable environments (#56) | [`docs/reproducibility.md`](reproducibility.md) |
| IAM, secrets, what is public | [`docs/infra-security.md`](infra-security.md) |
| Third-party components of the infra track | [`docs/open-source-infra.md`](open-source-infra.md) |

## Environments and stacks

Two isolated GCP projects, one per environment, with the same Terraform code and a `<env>.tfvars` each:

| Environment | Project | Region | Deployed from |
| --- | --- | --- | --- |
| `dev` | `sage-inquiry-512409-h3` (display name `huiledecloud-cloudnative-dev`) | `europe-west1` | every push to `dev` |
| `prd` | `huiledecloud-cloudnative-prd` | `europe-west9` | every `v*` tag (release) |

Four Terraform stacks, each with its own state (`gs://huiledecloud-<env>-tfstate/<stack>`):

| Stack | Holds | Applied by | Destroyed by `destroy.yml` |
| --- | --- | --- | --- |
| `infra/access` | WIF pool and provider, `gha-deploy` / `gha-plan` and their roles, team and instructor access, GitHub collaborators; since #134 also the frontend global IP and the Discord secret containers (`persistent.tf`) | a project Owner, by hand | **never** |
| `infra/billing` | Monthly budget and its email alerts | a project Owner, by hand | **never** |
| `infra/foundation` | VPC, subnets, firewall, Cloud NAT, GKE cluster and node pool of the runners, ARC (Helm) | the pipeline (`deploy-env.yml`) | yes |
| `infra/serverless` | The whole application (functions, gateway, Pub/Sub, Firestore, buckets, front) | the pipeline (`deploy-env.yml`) | yes |

`access` and `billing` stay out of the pipeline on purpose: they hold the identities the pipeline itself uses and the
people who can fix it. A broken pipeline or a destroy can never lock anyone out.

The state bucket is created once per environment by `scripts/bootstrap-state-bucket.sh` (uniform bucket-level access,
public access prevention, object versioning). It is the only resource outside the four stacks.

## Foundation (`infra/foundation`)

| Component | Configuration | Why |
| --- | --- | --- |
| VPC `huiledecloud-<env>-vpc` | custom mode; subnet `10.x.1.0/24` (general) and `10.x.2.0/24` (runners, with secondary ranges for pods and services), private Google access, flow logs | one VPC per project, nothing shared between dev and prd (`10.0.0.0/16` dev, `10.1.0.0/16` prd) |
| Firewall | explicit `deny-all-ingress` at priority 65534 | nothing reaches the VPC unless a more specific rule allows it |
| GKE `huiledecloud-dev-runners` | zonal (`europe-west1-b`), REGULAR channel, **private nodes**, Workload Identity, Dataplane V2 (network policies), DNS-based control plane endpoint, IP endpoint closed (empty authorized networks) | zonal on purpose: a regional cluster would run the node pool in 3 zones (min/max are per zone) and pay the management fee, while one zonal cluster per billing account is covered by the GKE free tier; the control plane is reached through IAM only, so the GitHub-hosted deploy jobs need no allowed IP |
| Node pool `runners` | `e2-standard-4` Spot, **autoscaling 1 → 3 nodes**, shielded nodes, `GKE_METADATA`, dedicated node service account | node autoscaling is what the subject asks for (not only pod scaling); Spot divides the cost; 3 nodes is the cost ceiling |
| Cloud NAT + router | auto-allocated IP, runners subnet only, error logging | private nodes reach GitHub and the Google APIs outbound; nothing can come in |
| ARC (Helm, by Terraform) | `gha-runner-scale-set-controller` in `arc-systems`, scale set `huiledecloud-dev-runners` in `arc-runners`, 0 → 4 ephemeral runners, LimitRange, NetworkPolicies (egress to the Internet only, ingress denied) | one pod per job, deleted when the job ends: no state or credential shared between jobs |

The cluster only exists in dev (`runners_enabled = true` in `dev.tfvars`): a single scale set serves both
environments, so a prd cluster would be billed for nothing.

## CI/CD (`.github/workflows`)

| Workflow | Trigger | What it does | Identity |
| --- | --- | --- | --- |
| `ci-terraform` | PR touching `infra/**` | `fmt -check`, `validate` of the 4 stacks, `terraform test` of the modules, tflint, checkov; then `plan` of foundation and serverless on dev **and** prd, posted as a PR comment | `gha-plan` (read-only), not bound to an Environment |
| `ci-functions`, `ci-frontend`, `ci-firestore-rules` | PR, path-filtered | tests, coverage thresholds, `npm audit`, Firestore rules in the emulator | none |
| `ci-security` | every PR, push to `main` | gitleaks (blocking: PR range, full history on `main`), semgrep (non-blocking) | none |
| `ci-gate` | every PR | the **only required check**: waits for the path-filtered workflows that apply to the PR | none |
| `pr-title` | PR | title follows Conventional Commits (it becomes the squash commit read by semantic-release) | none |
| `check-source-branch` | PR to `main` | only `dev` can be merged into `main` | none |
| `release` | push to `main` | semantic-release: `vX.Y.Z` tag and GitHub release, pushed with a GitHub App token so that the tag triggers `deploy` | release GitHub App |
| `deploy` | push to `dev`, `v*` tag | builds the functions zip and the front **once**, then `deploy-env` on dev (push to `dev`) or on prd (tag, gated by the prd required reviewers), then `architecture` after prd | — |
| `deploy-env` (reusable) | called by `deploy` | `terraform apply` foundation then serverless, registers the slash commands, smoke tests (`app_url`, gateway `/health`) | `gha-deploy` of the Environment |
| `destroy` | manual (`env`, `confirm = destroy-<env>`) | destroys serverless then foundation; since #134, also removes the buckets Cloud Functions creates outside Terraform and fails if anything billable is left (`scripts/check-leftovers.sh`) | `gha-deploy` of the Environment |
| `architecture` | after a prd deploy, or manual | reads the deployed state (names and types only), asks a model to group them, renders the diagram with d2 and opens a PR to `dev` | `gha-deploy` (read), then no cloud credential |
| `wif-isolation` | manual | proves a `dev` job gets the dev deploy account and is refused both prd accounts | WIF only |

GitFlow: short-lived `feature/*` branches (ruleset `branch name`), PR with review into `dev`, squash merge only, then
`dev` → `main` by PR; `main`, `dev` and the `v*` tags are protected by rulesets. Every commit is signed.

Runner selection: untrusted jobs (PR CI) run on `${{ vars.CI_RUNNER || 'ubuntu-latest' }}`, jobs that hold credentials
on `${{ vars.CI_RUNNER_TRUSTED || 'ubuntu-latest' }}`. `deploy-env` and `destroy` always run on GitHub-hosted runners:
they create and destroy the runners' own cluster. While the dev cluster is destroyed, `CI_RUNNER` must be set back to
`ubuntu-latest`, otherwise every PR job waits for a runner that does not exist.

## Design choices to defend

| Choice | Why |
| --- | --- |
| **Keyless CI**: Workload Identity Federation, one pool per project | No service account key exists anywhere. A job gets a 1 h token only if the repository (by name **and** immutable ids) and the GitHub Environment match; a `dev` job is refused by the prd pool (`wif-isolation`) |
| **Two pipeline identities** | `gha-plan` can only read (PR plans of untrusted code); `gha-deploy` has one role per resource family instead of `roles/editor`, and can only grant the roles of an allow-list (IAM condition) |
| **Access out of the pipeline** | The pipeline cannot change who has access, nor its own permissions. Destroying the workload never removes people |
| **Private cluster, outbound only** | No public IP on the nodes, no ingress (firewall + NetworkPolicy), control plane through IAM: the runners are not reachable from the Internet |
| **Ephemeral runners with node autoscaling** | One pod per job; pending pods make the cluster autoscaler add a node (1 → 3), idle nodes are removed. Spot nodes and the ceilings bound the cost |
| **Build once per ref, promote by tag** | `deploy` builds the zip and the front once per run and applies that artifact; dev follows the `dev` branch, prd only a release tag of `main` (which only receives `dev`), behind the prd required reviewers |
| **Plans on both environments for every PR** | A change that breaks prd is seen in the PR, not after the release |
| **Reproducible and disposable** | `deploy` recreates an environment from scratch; `destroy` removes everything billable except the access stack, the budgets and the state bucket, and checks it (#134) |
| **Budgets on gross cost** | Credits are excluded (`EXCLUDE_ALL_CREDITS`): the alert shows how fast the credits burn, which a budget net of credits would hide at 0 |

## After a destroy and a re-apply

Since #134, the frontend IP and the Discord secret containers survive a destroy (`infra/access/persistent.tf`): the
dev URL, its certificate and the Discord OAuth2 redirect URIs stay the same, and the secret values are kept. What still
needs a person (outside GCP, see [`reproducibility.md`](reproducibility.md)):

- the runners' GitHub App secret, a Kubernetes secret created by hand in the new cluster ([runners doc](ci/self-hosted-runners.md), Install §4);
- the new API Gateway host in the Discord Activity URL mapping (`/api`) and, once `discord-proxy` is on, the
  Interactions Endpoint URL;
- `CI_RUNNER`, back to the scale set name once the runners are up.

On a brand-new environment (or after the resources of `persistent.tf` were deleted), apply `infra/access` and add the
secret values **before** the first deploy: `infra/serverless` reads the IP and the secrets with data sources.
