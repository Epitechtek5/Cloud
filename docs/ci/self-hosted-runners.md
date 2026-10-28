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
                         GKE nodes (private, runners subnet, Spot)
                                            |
                                  Cloud NAT --> internet
```

| Layer | Where | What |
| --- | --- | --- |
| Network | `infra/foundation/main.tf` | `runners` subnet + secondary ranges for pods and services |
| Cluster | `infra/foundation/gke.tf` | private GKE, Workload Identity, Calico network policy, Cloud NAT, bounded node pool |
| Runners | `k8s/runners/` | Helm values for the controller and the scale set, egress NetworkPolicy, `install.sh` |

## Install

1. **Create a GitHub App** on the organization (Repository permissions: Actions read, Administration read and
   write, Metadata read), install it on this repository and download its private key.
2. **Apply the Terraform** (`infra/foundation`) through the usual deploy workflow. Set
   `runners_authorized_networks` in the tfvars with the public IP of the machine that will run Helm.
3. **Install ARC** from that machine (needs `gcloud`, `helm` and `kubectl`):

   ```bash
   ENV=dev REGION=europe-west1 \
   GITHUB_APP_ID=... GITHUB_APP_INSTALLATION_ID=... GITHUB_APP_PRIVATE_KEY_FILE=./app.pem \
   k8s/runners/install.sh
   ```

   The script is idempotent: run it again to upgrade. The private key only exists in the Kubernetes secret
   `arc-github-app`; never commit it.
4. **Switch the workflows**: set the `CI_RUNNER` repository variable to the scale set name
   (`huiledecloud-dev-runners`). A scale set is selected by its name in `runs-on`.

The cluster is created by workflows that can run on GitHub-hosted runners (`CI_RUNNER` unset), so there is no
bootstrap loop: keep the fallback until the runners are validated.

## How it covers the runner guardrails

| Requirement of [runner-guardrails.md](runner-guardrails.md) | Implementation |
| --- | --- |
| Ephemeral runners | ARC scale sets: one pod per job, deleted at the end |
| Bounded fleet | `maxRunners` (Helm values) and `runners_max_nodes` (node pool ceiling) |
| Idle TTL | `minRunners: 0` and the node pool autoscaler |
| Least-privilege service account | dedicated node service account with logging/monitoring/image-pull roles only |
| Dedicated subnet | nodes in the `runners` subnet, no public IP |
| No access to the node identity | `GKE_METADATA` (Workload Identity): pods cannot use the node service account |
| Contained egress | NetworkPolicy: internet only, no private ranges |

Still to do outside this change: the budget alert, "Require approval for all outside collaborators", and
removing the `|| 'ubuntu-latest'` fallback once the runners are live.

## Operate

```bash
kubectl -n arc-systems get pods          # controller and listener
kubectl -n arc-runners get pods          # runners currently running a job
helm -n arc-runners list                 # installed scale set
```

- **Scale**: edit `maxRunners` in `k8s/runners/runner-set-values.yaml` and rerun `install.sh`.
- **Upgrade ARC**: bump `ARC_VERSION` in `install.sh` and rerun it.
- **Spot preemption**: a job running on a preempted node fails and must be re-run. Set `runners_spot = false`
  if that becomes a problem.
- **Docker in the runner**: jobs get a `dind` sidecar (needed for container actions), which runs privileged
  inside the pod. This is acceptable because pods are ephemeral and isolated by the network policy, but keep
  fork PRs disabled.
