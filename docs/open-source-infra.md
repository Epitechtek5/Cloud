# Open-source components: infra track

Subject 5.4 / 5.6, issue #80: every third-party component the infra track relies on (workflows, Helm charts, images,
Terraform providers, CI tools, external services), with its version, what it does for us and why we trust it. The
functions track lists theirs in [`open-source-functions.md`](open-source-functions.md) (#81); the shared index
`docs/open-source.md` (#78) links the tracks.

Selection rules applied:

- **Official first**: GitHub, Google and HashiCorp components; one community action (`dorny/paths-filter`), justified
  below. No third-party Terraform module: the modules of the repository are ours.
- **Pinned where it changes what is deployed**: Terraform providers by the committed `.terraform.lock.hcl` of each
  stack, the ARC charts and the runner image by exact version, gitleaks by exact version and checksum.
- **Least privilege for every job**: `permissions: contents: read` by default, `id-token: write` only on the jobs that
  authenticate to GCP, secrets only in the jobs that need them.

## GitHub Actions

| Action | Version | Used in | Used for | Why it is safe |
| --- | --- | --- | --- | --- |
| `actions/checkout` | v4 | every workflow | checkout | official GitHub action |
| `actions/setup-node` | v4 | CI of functions, front, Firestore rules, release, deploy | Node 22 and the npm cache | official GitHub action |
| `actions/setup-python` | v5 | `ci-terraform`, `ci-security` | Python 3.12 for checkov and semgrep | official GitHub action |
| `actions/setup-java` | v4 | `ci-firestore-rules` (and `ci-functions` once #126 is merged) | Java 21 for the Firestore emulator | official GitHub action |
| `actions/cache` | v4 | `ci-firestore-rules` | cache of the emulator jar | official GitHub action |
| `actions/upload-artifact`, `actions/download-artifact` | v4 | `deploy`, `architecture`, CI | hands the built zip and front, or the diagram input, between jobs | official GitHub actions |
| `actions/github-script` | v7 | `ci-terraform` | posts the plan of each stack and environment as a PR comment | official GitHub action, only `pull-requests: write` on that job |
| `actions/create-github-app-token` | v1 | `release`, `architecture` | short-lived token of the release GitHub App (a tag pushed with `GITHUB_TOKEN` would not trigger `deploy`) | official GitHub action; the token expires after 1 h |
| `google-github-actions/auth` | v2 | every job that reaches GCP | Workload Identity Federation: exchanges the GitHub OIDC token for a 1 h Google token | official Google action, no key involved |
| `hashicorp/setup-terraform` | v3 | Terraform jobs | installs Terraform (`terraform_wrapper: false`: the wrapper needs Node, missing on the runner image) | official HashiCorp action |
| `terraform-linters/setup-tflint` | v4 | `ci-terraform` | installs tflint | official action of the tflint project |
| `dorny/paths-filter` | v3 | `ci-gate` | tells which path-filtered workflows apply to a PR, so that one required check covers them all | the only community action: widely adopted, actively maintained, read-only (it only reads the changed files, no secret, `contents: read`) |

Actions are referenced by major tag, like every workflow of the repository. Moving to commit SHAs (with an update bot)
is listed as a known trade-off in [`infra-security.md`](infra-security.md).

## Kubernetes: charts and images (`infra/foundation/runners.tf`)

| Component | Version | Source | Used for | Why |
| --- | --- | --- | --- | --- |
| `gha-runner-scale-set-controller` | 0.15.1 (`runners_arc_version`) | `oci://ghcr.io/actions/actions-runner-controller-charts` | ARC controller and listener (`arc-systems`) | official GitHub Actions Runner Controller, the self-hosted runner solution documented by GitHub |
| `gha-runner-scale-set` | 0.15.1 | same OCI registry | the scale set `huiledecloud-dev-runners`, 0 to 4 ephemeral runners (`arc-runners`) | same project, same version as the controller (required) |
| `ghcr.io/actions/actions-runner` | 2.338.2 | GitHub Container Registry | the runner container of each job pod | official runner image, exact tag bumped on purpose (ARC refuses runner self-updates) |
| `docker:dind` sidecar | set by the chart | Docker Hub (official image) | Docker in the job pod (`containerMode: dind`) | official Docker image; the privilege it needs is listed in [`infra-security.md`](infra-security.md) |

## Terraform providers

| Provider | Constraint | Stacks | Used for |
| --- | --- | --- | --- |
| `hashicorp/google` | `~> 7.0` | all | every GCP resource |
| `hashicorp/google-beta` | `~> 7.0` | serverless | API Gateway (beta-only resources) |
| `hashicorp/helm` | `~> 3.1` | foundation | the two ARC releases |
| `hashicorp/kubernetes` | `~> 3.0` | foundation | namespaces, LimitRange and NetworkPolicies of the runners |
| `integrations/github` | `~> 6.0` | access | repository collaborators (team, instructor) |
| `hashicorp/archive` | `~> 2.7` | serverless | local fallback zip of the functions when no CI artifact is given |

All are official (HashiCorp, or GitHub for `integrations/github`). The exact versions and their checksums are in the
committed `.terraform.lock.hcl` of each stack; `required_version = ">= 1.9"` everywhere (the `removed` blocks of #134
need 1.7 or later).

## CI tools installed by the workflows

| Tool | Version | Installed by | Used for | Note |
| --- | --- | --- | --- | --- |
| Terraform | latest 1.x | `setup-terraform` | fmt, validate, test, plan, apply, destroy | the lock files pin the providers; pinning the CLI version is cheap and would make runs reproducible |
| tflint | latest | `setup-tflint` | Terraform lint (`tflint --recursive`) | blocking |
| checkov | `>=3,<4` (pip) | `ci-terraform` | Terraform security checks; every `#checkov:skip` in the code carries its reason | blocking |
| gitleaks | 8.21.2, checksum verified | `ci-security` | secret scanning of the PR range and of the `main` history | blocking; the official binary instead of `gitleaks-action` (which needs a licence for organisations) |
| semgrep | latest (pip) | `ci-security` | SAST of the functions and the front | non-blocking until the first findings are triaged |
| semantic-release | 24, with `conventional-changelog-conventionalcommits` 8 | `npx` in `release` | versions, tags and GitHub releases from Conventional Commits | major version pinned |
| d2 | 0.6.9 | release tarball in `architecture` | renders the architecture diagram | downloaded from the official GitHub release |

## Scripts of the repository (`scripts/`)

Written by us, they only call `gcloud`, `gh`, `curl` and `jq`: `bootstrap-state-bucket.sh` (state bucket),
`publish-github-variables.sh` (GitHub variables from the outputs of `infra/access`), `check-private-access.sh`
(buckets and Firestore closed to an anonymous client), `test-discord-proxy.sh`, `test-pubsub-dlq.sh`, and since #134
`check-leftovers.sh` (nothing billable left after a destroy).

## External services

| Service | Used by | What leaves the project | Why |
| --- | --- | --- | --- |
| GitHub Actions and GHCR | CI/CD, runner images and charts | the repository content (already public), OIDC tokens | the subject's CI platform |
| sslip.io | the frontend domain `<a-b-c-d>.sslip.io` | nothing: it resolves a name to the IP it contains | a Google-managed certificate needs a domain name; sslip.io gives one without buying a domain. If it is down, the IP still answers, but the certificate and the Discord redirect URIs need the name |
| Anthropic API (`ARCH_MODEL`, default `claude-haiku-5-5`) | `architecture` (generate job) | Terraform addresses, types and names of the deployed resources, no attribute value; the job has no cloud credential | groups and labels the resources of the generated diagram; its answer is JSON, validated then rendered by our own script, never executed |
