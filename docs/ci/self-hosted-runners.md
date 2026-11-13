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
| Cluster | `infra/foundation/gke.tf` | private zonal GKE, DNS-based control plane endpoint, Workload Identity, Dataplane V2 network policy, Cloud NAT, bounded node pool |
| Runners | `infra/foundation/runners.tf` | namespaces, LimitRange, NetworkPolicy, ARC controller and scale set (`helm_release`, pinned chart version) |
| Helm values | `k8s/runners/*-values.yaml` | static values of the two charts; Terraform adds the per-environment ones (names, `minRunners` / `maxRunners`) |

Everything is applied by Terraform through the pipeline: a release tag deploys the cluster, then the controller, then
the scale set, on dev then prd (`deploy.yml` → `deploy-env.yml`), and every PR plans it (`ci-terraform.yml`).
Nothing is installed from a laptop.

### How the pipeline reaches the cluster

The Helm and Kubernetes providers are configured from the cluster outputs, with no kubeconfig file: they target
the **DNS-based endpoint** of the control plane and authenticate with the short-lived OAuth token of the
identity running Terraform. Access through that endpoint is checked by IAM, not by source IP, so the
GitHub-hosted runners of `deploy-env.yml` get in although their IPs are unknown. The IP-based endpoint stays
closed by the (empty) authorized networks.

| Identity | IAM role | What it can do in the cluster |
| --- | --- | --- |
| `gha-deploy` (deploy, destroy) | `roles/editor` + custom role `ghaDeployK8sRbac` | install the charts, which create ClusterRoles, Roles and their bindings |
| `gha-plan` (PR plan) | `roles/viewer` | read namespaces, policies and the Helm releases, never the Secrets |

On GKE, `roles/editor` cannot create Kubernetes Roles and bindings. `roles/container.admin` could, but it also
carries impersonation (`container.clusters.impersonate`), token creation for Kubernetes service accounts and CSR
approval. The custom role `ghaDeployK8sRbac` (`scripts/bootstrap-wif.sh`) holds only the 16 permissions on
(Cluster)Roles and (Cluster)RoleBindings. `bind` and `escalate` are part of them: without them no chart could bind
a role with more rights than `roles/editor` gives. In practice the deploy account can give itself any right
inside the runners cluster, and nothing outside it; the cluster only hosts the runners.

Helm records its releases in **ConfigMaps** (`helm_driver = "configmap"`), not in Secrets: that is what lets the
read-only plan account refresh them. The values hold no credential, the GitHub App key stays in its own Secret.

### Order and destroy

Terraform applies cluster + node pool + NAT → namespaces, LimitRange, NetworkPolicy → controller → scale set.
`destroy.yml` walks the same graph backwards: the scale set is uninstalled while the controller, the nodes and
the NAT still run, so the controller deletes the scale set registration from GitHub (Settings → Actions →
Runners) before being uninstalled itself. No registration is left behind.

## Install

1. **Create a GitHub App** on the organization (Repository permissions: Actions read, Administration read and
   write, Metadata read), install it on this repository and download its private key.
2. **Give the deploy account the Kubernetes RBAC role** (`ghaDeployK8sRbac`) by running
   `scripts/bootstrap-wif.sh` again on the project (Owner needed). The `container` and `cloudresourcemanager` APIs
   are enabled by Terraform (`infra/foundation/apis.tf`).
3. **Deploy** through the usual release flow. The cluster only exists in dev (`runners_enabled = true` in
   `dev.tfvars`): the runners are a single scale set, so a prd cluster would be billed for nothing.
4. **Create the GitHub App secret, once per cluster.** It is the only manual step left (issue #54 moves it to
   Secret Manager). The scale set waits for it: the listener starts as soon as the secret exists. The DNS
   endpoint needs no authorized network, only your IAM access:

   ```bash
   gcloud container clusters get-credentials huiledecloud-dev-runners --dns-endpoint \
     --zone europe-west1-b --project <project_id>
   kubectl -n arc-runners create secret generic arc-github-app \
     --from-literal=github_app_id=<app id> \
     --from-literal=github_app_installation_id=<installation id> \
     --from-file=github_app_private_key=./app.pem
   ```

   The private key only exists in that Kubernetes secret; never commit it. A destroy deletes the namespace and
   the secret with it: create it again after the next deploy.
5. **Switch the workflows**, after the fork PR setting of the next section: set the `CI_RUNNER` repository variable
   to the scale set name (`huiledecloud-dev-runners`, the `runners_scale_set_name` output) for the untrusted jobs
   (CI on PRs). A scale set is selected by its name in `runs-on`.

Two variables, two trust levels:

| Variable | Used by | Default |
| --- | --- | --- |
| `CI_RUNNER` | CI jobs (lint, tests, security, PR checks), which run code from PRs | `ubuntu-latest` |
| `CI_RUNNER_TRUSTED` | jobs holding GCP credentials or secrets: `deploy.yml`, `release.yml`, `architecture.yml` (prd/dev state, `ANTHROPIC_API_KEY`, release app key) | `ubuntu-latest` |

The `plan` job of `ci-terraform.yml` stays on `CI_RUNNER` on purpose: it runs the Terraform of the PR (providers,
`external` data sources), so putting it on the trusted pool would run PR code next to the deploy credentials. Fork
PRs are excluded from it, and its service account is read-only (plan). This is an accepted residual risk: a PR
from the repository itself can already change the workflows.

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
| Bounded fleet | `runners_max_runners` (scale set `maxRunners`) and `runners_max_nodes` (node pool ceiling) |
| Idle TTL | `runners_min_runners = 0` (no runner pod when idle); the node pool keeps `runners_min_nodes` (1) node for the ARC controller |
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

Read-only checks, after `gcloud container clusters get-credentials ... --dns-endpoint` (changes go through
Terraform, never through `helm` or `kubectl apply`):

```bash
kubectl -n arc-systems get pods                         # controller and listener
kubectl -n arc-runners get pods                         # runners currently running a job
HELM_DRIVER=configmap helm -n arc-runners list          # installed scale set (releases are in ConfigMaps)
```

- **Scale**: change `runners_max_runners` (and `runners_max_nodes` first, see the sizing note in
  `k8s/runners/runner-set-values.yaml`) in the tfvars, then release.
- **Upgrade ARC or the runner**: bump `runners_arc_version` (both charts move together) or the image tag in
  `runner-set-values.yaml`, then release. The PR plan shows the Helm diff.
- **Spot preemption**: a job running on a preempted node fails and must be re-run. The ARC controller and
  listener run on the same Spot node: when it is preempted, queued jobs wait until they are rescheduled. Set
  `runners_spot = false` if that becomes a problem.
- **Docker in the runner**: jobs get a `dind` sidecar (needed for container actions), which runs privileged
  inside the pod. This is acceptable because pods are ephemeral and isolated by the network policy, as long as
  fork PRs require approval (see above).
