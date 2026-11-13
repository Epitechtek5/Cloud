# infra/access

Keyless authentication of the pipeline to GCP, as code (subject 2.1, C03 §4 and §11). One state per environment
(prefix `access`).

| File | Content |
|---|---|
| `wif.tf` | Required APIs, the `github` Workload Identity pool and its GitHub OIDC provider |
| `service_accounts.tf` | `gha-deploy` and `gha-plan`, and who may impersonate them (`roles/iam.workloadIdentityUser`) |
| `roles.tf` | What each account may do, every role with its reason |
| `<env>.tfvars` | Project, environment, state bucket |
| `import.sh` | One-shot adoption of the resources created by the former `scripts/bootstrap-wif.sh` |
| `outputs.tf` | Provider, account and bucket names, read by `scripts/publish-github-variables.sh` |

Like `infra/billing`, this stack is **applied by a project Owner, never by the pipeline**, and never destroyed by
`destroy.yml`. The pipeline identities cannot change their own rights, and a destroy of the workload leaves the
pipeline able to deploy again.

## How a job authenticates

1. The job asks GitHub for an OIDC token (`id-token: write`). Its `sub` claim names the repository and, for a job
   that runs in a GitHub Environment, the Environment: `repo:Epitechtek5/Cloud:environment:dev`.
2. `google-github-actions/auth` exchanges it with STS against the provider of the target project. The provider
   **attribute condition** must hold, or the exchange is refused:
   - repository name **and** immutable ids (`repository_owner_id`, `repository_id`): a deleted or renamed
     repository re-created under the same name by someone else is refused;
   - a job running in a GitHub Environment is accepted only by the pool of **that** environment: the dev pool
     refuses a `prd` job, the prd pool refuses a `dev` job. Jobs without an Environment (PR plan) pass.
3. The federated identity impersonates a service account for one hour, if it holds `workloadIdentityUser` on it:

| Account | Who may impersonate it | Used by |
|---|---|---|
| `gha-deploy` | exactly the subject `repo:Epitechtek5/Cloud:environment:<env>` (and its id-based form, see below) | `deploy-env.yml`, `destroy.yml`, `architecture.yml` |
| `gha-plan` | any job of the repository (`attribute.repository`) that passes the condition | `ci-terraform.yml` (PR plan) |

GitHub can send the subject in an id-based form (`repo:Epitechtek5@345497600/Cloud@1429506566:environment:dev`)
depending on the repository OIDC setting. Both forms are bound to `gha-deploy`, both carry the environment.

No service account key exists: the credentials are short-lived tokens only.

## Roles

### gha-deploy

| Role | Why |
|---|---|
| `roles/viewer` | Refresh: read every resource and policy of the stacks |
| `roles/serviceusage.serviceUsageAdmin` | `google_project_service` of every stack |
| `roles/compute.networkAdmin` | VPC, subnets, router, NAT, global address, load balancer (URL maps, proxies, forwarding rules, backend bucket) |
| `roles/compute.securityAdmin` | Firewall rules, SSL policy and managed certificate of the load balancer |
| `roles/container.clusterAdmin` | GKE runners cluster and node pool |
| `roles/container.developer` | Kubernetes objects of the runners charts (namespaces, deployments, CRDs, config maps, network policies) |
| `roles/iam.serviceAccountAdmin` | One service account per function and node pool |
| `roles/iam.serviceAccountUser` | `actAs`: run the node pool and the functions as their own service accounts |
| `roles/cloudfunctions.developer` | Cloud Functions (2nd gen) |
| `roles/artifactregistry.admin` | Artifact Registry repository of the functions |
| `roles/secretmanager.admin` | Secret Manager secrets (containers only, the values are added by hand) |
| `roles/storage.admin` | Buckets (frontend, function sources, data) and their objects |
| `roles/pubsub.editor` | Pub/Sub topics, subscriptions and dead-letter topics |
| `roles/datastore.owner` | Firestore database, indexes and fields |
| `roles/firebaserules.admin` | Firestore security rules (ruleset and release) |
| `roles/resourcemanager.projectIamAdmin`, condition `grantable-roles-only` | The stacks bind project roles to the service accounts they create (node pool, functions, build). The condition limits it to the roles of `deploy_grantable_roles`: it can never grant itself `roles/owner` |
| custom `ghaDeployIamBindings` | `get/setIamPolicy` on the resources the stacks bind (secrets, Cloud Run, Artifact Registry, buckets, Pub/Sub, service accounts). Only reaches the resource itself |
| custom `ghaDeployK8sRbac` | The ARC Helm charts create (Cluster)Roles and bindings. `roles/container.admin` would also bring impersonation, token creation and CSR approval ([runners doc](../../docs/ci/self-hosted-runners.md)) |
| `roles/storage.objectAdmin` on the state bucket | Read and write the states and their locks |

Not granted on purpose: `roles/owner`, `roles/iam.securityAdmin`, `roles/iam.serviceAccountKeyAdmin`,
`roles/iam.serviceAccountTokenCreator` at project level, any role on the billing account.

**Why not `roles/editor`.** `bootstrap-wif.sh` granted `roles/editor`. It holds `iam.serviceAccountKeys.create`:
the deploy account could create a JSON key for any service account of the project, a long-lived credential the
subject forbids. The projects have no organization, so neither the `iam.disableServiceAccountKeyCreation` org
policy nor an IAM deny policy (`roles/iam.denyAdmin` is not grantable on a project) can block it: the only way is
to not grant it. The roles above were chosen from what the pipeline really does (Admin Activity audit logs of
`gha-deploy` over 60 days, plus the resource types of the open Firestore and Pub/Sub PRs) and checked against the
role definitions: they cover every permission of `roles/editor` on those resource types, and none of them holds
`iam.serviceAccountKeys.create`, `getAccessToken`, `signBlob`, `signJwt`, `implicitDelegation` or
`resourcemanager.projects.setIamPolicy`. `roles/compute.loadBalancerAdmin` was left out: `networkAdmin` and
`securityAdmin` already cover the load balancer.

A stack using a **new resource type** (Eventarc, Cloud Scheduler, ...) needs its role added here and this stack
applied on dev and prd first, otherwise the deploy fails with `403 ... Permission '<x>' denied`.

Remaining trust, on purpose: `iam.serviceAccountUser` and `iam.serviceAccountAdmin` are project-wide (the accounts
are created by the stacks, they cannot be listed here in advance), so the deploy account can act as, and change
the IAM policy of, any service account of its project (it already could through `ghaDeployIamBindings`). Through
that policy it could grant itself token creation on another account: the Compute Engine and App Engine default
accounts still hold `roles/editor` (a GCP default) and would give the key permission back. No workload of the
stacks runs as them; taking `roles/editor` away from them closes that path and is left to a follow-up.

### gha-plan

| Role | Why |
|---|---|
| `roles/viewer` | Refresh every resource of the stacks |
| `roles/iam.securityReviewer` | Read the IAM policies of the resources (refresh of every `*_iam_member`) |
| `roles/firebaserules.viewer` | Read the Firestore security rules, which `roles/viewer` does not cover |
| `roles/storage.objectViewer` on the state bucket | Read the states |
| `roles/storage.objectUser` on the state bucket, condition `plan-lock-files` | `terraform init` writes a `.tflock` even for a plan: writes on lock files only, never on a state |

## Apply

You need **Owner** on the project. Example for dev:

```sh
gcloud auth application-default login
terraform -chdir=infra/access init -reconfigure -backend-config=backends/dev.hcl
terraform -chdir=infra/access plan -var-file=dev.tfvars
terraform -chdir=infra/access apply -var-file=dev.tfvars
scripts/publish-github-variables.sh dev
```

For prd, use `backends/prd.hcl` and `prd.tfvars`. The variables only change when the stack is created, so
`publish-github-variables.sh` is needed on a new project, not on every apply.

### First run on a project created by `bootstrap-wif.sh`

The pool, the provider, the accounts and their bindings already exist. Adopt them before the first apply:

```sh
terraform -chdir=infra/access init -reconfigure -backend-config=backends/dev.hcl
infra/access/import.sh dev
terraform -chdir=infra/access plan -var-file=dev.tfvars
```

The first plan is not empty, on purpose: it updates the provider condition (environment and repository ids),
adds the display names and descriptions, replaces the `grantable-roles-only` binding (its description changes),
adds the narrow deploy roles, and on prd creates what `bootstrap-wif.sh` never did there (the two custom roles, the
conditional binding, the plan roles). After `apply`, take `roles/editor` away from the deploy account (it is not
managed by the stack, so Terraform does not remove it):

```sh
gcloud projects remove-iam-policy-binding <project_id> --condition=None \
  --member "serviceAccount:gha-deploy@<project_id>.iam.gserviceaccount.com" --role roles/editor
```

Then `plan` must show `No changes`. If a deploy fails with a `403` on a permission the roles above miss, add the
role to `deploy_project_roles` rather than giving `roles/editor` back.

### New project

1. `scripts/bootstrap-state-bucket.sh <project_id> huiledecloud-<env>-tfstate`: the state bucket is the only
   chicken-and-egg left, it must exist before any `init`.
2. Apply this stack, then `scripts/publish-github-variables.sh <env>`.

`scripts/bootstrap-wif.sh` is deleted: an Owner applies this stack directly, nothing needs a pipeline identity to
exist first. Keeping two sources of truth for the same IAM would let them drift.

## Checks

**No key.** Only Google-managed keys may be listed:

```sh
for p in sage-inquiry-512409-h3 huiledecloud-cloudnative-prd; do
  for sa in gha-deploy gha-plan; do
    gcloud iam service-accounts keys list --iam-account "$sa@$p.iam.gserviceaccount.com" --managed-by user
  done
done
```

Every list must be empty. A user-managed key is also blocked by the absence of `serviceAccountKeys.create` in
the roles of both accounts.

**Environment isolation.** Run the `wif-isolation` workflow (Actions, Run workflow; GitHub lists a manual workflow
once it is on the default branch). Its job runs in the `dev`
Environment and impersonates the dev deploy account (must succeed), then tries the prd deploy and plan accounts
(both must fail: the prd pool refuses a `dev` subject). The job fails if a prd account is reachable.

**Pipeline.** A PR touching `infra/` runs the plan (`gha-plan`), a push to `dev` runs the deploy (`gha-deploy`),
`destroy.yml` uses the same account as the deploy.

## GitHub Environments

The pipelines only use `dev` and `prd`, and they are the only Environments of the repository (the stray `prod` one
is gone: `gh api repos/Epitechtek5/Cloud/environments --jq '.environments[].name'`). A job in any other Environment
would be refused anyway: its subject ends with `:environment:<name>`, which no pool accepts.
