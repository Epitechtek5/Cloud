# Self-hosted runners on Kubernetes

The GitHub Actions runners run as ephemeral pods on a private GKE cluster, managed by
[Actions Runner Controller](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners-with-actions-runner-controller)
(ARC, runner scale sets). Tracked in issue #44.

## Architecture

```
GitHub  <--- long poll (HTTPS) ---  arc-systems: controller + listener
                                            |
                                  creates / deletes
                                            v
                              arc-runners: 1 ephemeral pod per job
                                            |
                         GKE nodes (zonal, private, runners subnet, Spot)
                                            |
                                  Cloud NAT --> internet
```

| Layer | Where | What |
| --- | --- | --- |
| Network | `infra/foundation/main.tf` | `runners` subnet + secondary ranges for pods and services |
| Cluster | `infra/foundation/gke.tf` | private zonal GKE, Workload Identity, Dataplane V2 network policy, Cloud NAT, bounded node pool |
| Runners | `k8s/runners/` | namespaces and egress NetworkPolicy (kustomize), Helm values for the controller and the scale set, `install.sh` (Helm and the GitHub App secret) |

## Install

1. **Create a GitHub App** on the organization (Repository permissions: Actions read, Administration read and
   write, Metadata read), install it on this repository and download its private key.
2. **Apply the Terraform** (`infra/foundation`) through the usual deploy workflow. The cluster only exists in dev
   (`runners_enabled = true` in `dev.tfvars`): the runners are a single scale set, so a prd cluster would be
   billed for nothing. The deploy service account needs `container.admin`, `iam.serviceAccountAdmin`,
   `resourcemanager.projectIamAdmin`, `compute.networkAdmin`, and `iam.serviceAccountUser` on the node service
   account, and `container.googleapis.com` must be enabled on the project.
3. **Allow your machine to reach the control plane.** The authorized networks are managed outside Terraform
   (`ignore_changes`), so a deploy never resets them and your IP is never committed:

   ```bash
   gcloud container clusters update huiledecloud-dev-runners --zone europe-west1-b --project <project_id> \
     --enable-master-authorized-networks --master-authorized-networks <your-ip>/32
   ```
4. **Install ARC** from that machine (needs `gcloud`, `helm` and `kubectl`):

   ```bash
   ENV=dev ZONE=europe-west1-b PROJECT=<project_id> \
   GITHUB_APP_ID=... GITHUB_APP_INSTALLATION_ID=... GITHUB_APP_PRIVATE_KEY_FILE=./app.pem \
   k8s/runners/install.sh
   ```

   The script is idempotent: run it again to upgrade. The private key only exists in the Kubernetes secret
   `arc-github-app` (applied server-side, so no copy in an annotation); never commit it.
5. **Switch the workflows**, after the fork PR setting of the next section: set the `CI_RUNNER` repository variable
   to the scale set name (`huiledecloud-dev-runners`) for the untrusted jobs (CI on PRs). A scale set is selected
   by its name in `runs-on`.

Two variables, two trust levels:

| Variable | Used by | Default |
| --- | --- | --- |
| `CI_RUNNER` | CI jobs (lint, tests, security, PR checks), which run code from PRs | `ubuntu-latest` |
| `CI_RUNNER_TRUSTED` | jobs holding GCP credentials or secrets: `deploy.yml`, `release.yml`, `architecture.yml` (prd/dev state, `ANTHROPIC_API_KEY`, release app key) and the `plan` job of `ci-terraform.yml` (plan service accounts, state) | `ubuntu-latest` |

Leave `CI_RUNNER_TRUSTED` unset until a second scale set (and node pool) reserved for trusted jobs exists: it
must never point to the pool shared with PRs. `deploy-env.yml` and `destroy.yml` always run on `ubuntu-latest`:
they create and destroy this very cluster, so running them on its runners would kill the job in the middle of a
`terraform destroy` and leave the state lock behind.

The cluster is created by workflows that can run on GitHub-hosted runners (`CI_RUNNER` unset), so there is no
bootstrap loop: keep the fallback until the runners are validated.

## How it covers the runner guardrails

| Requirement of [runner-guardrails.md](runner-guardrails.md) | Implementation |
| --- | --- |
| Ephemeral runners | ARC scale sets: one pod per job, deleted at the end |
| Bounded fleet | `maxRunners` (Helm values) and `runners_max_nodes` (node pool ceiling) |
| Idle TTL | `minRunners: 0` (no runner pod when idle); the node pool keeps `runners_min_nodes` (1) node for the ARC controller |
| Least-privilege service account | dedicated node service account with `container.defaultNodeServiceAccount` only |
| Dedicated subnet | nodes in the `runners` subnet, no public IP |
| No access to the node identity | `GKE_METADATA` (Workload Identity): pods cannot use the node service account |
| Contained network | NetworkPolicy: ingress denied, egress to the internet only (no private ranges) |

Still to do outside this change: the budget alert, the fork PR setting below, and removing the
`|| 'ubuntu-latest'` fallback once the runners are live.

## Before setting `CI_RUNNER` (public repository)

A pull request from a fork runs workflows on our nodes, next to a privileged `dind` sidecar. First enable
*Settings → Actions → General → Fork pull request workflows from outside collaborators → Require approval for
all outside collaborators*. Forks cannot be disabled on a public repository, only gated by an approval.
A container escape from a PR job could read the GCP tokens of a `deploy` job on the same node, which is why
`CI_RUNNER_TRUSTED` is separate from `CI_RUNNER`.

## Operate

```bash
kubectl -n arc-systems get pods          # controller and listener
kubectl -n arc-runners get pods          # runners currently running a job
helm -n arc-runners list                 # installed scale set
```

- **Scale**: edit `maxRunners` in `k8s/runners/runner-set-values.yaml` and rerun `install.sh`.
- **Upgrade ARC or the runner**: bump `ARC_VERSION` in `install.sh` and the image tag in `runner-set-values.yaml`, then rerun `install.sh`.
- **Spot preemption**: a job running on a preempted node fails and must be re-run. The ARC controller and
  listener run on the same Spot node: when it is preempted, queued jobs wait until they are rescheduled. Set
  `runners_spot = false` if that becomes a problem.
- **Docker in the runner**: jobs get a `dind` sidecar (needed for container actions), which runs privileged
  inside the pod. This is acceptable because pods are ephemeral and isolated by the network policy, as long as
  fork PRs require approval (see above).
