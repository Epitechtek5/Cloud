# Self-hosted runners on Kubernetes

The GitHub Actions runners run as ephemeral pods on a private GKE cluster, managed by
[Actions Runner Controller](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners-with-actions-runner-controller)
(ARC, runner scale sets). Tracked in issue #44; the GitHub App credentials come from Secret Manager (issue #54).

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
| Runners | `infra/foundation/runners.tf`, `infra/foundation/gke.tf` | namespaces, LimitRange, NetworkPolicy, ARC controller and two scale sets (`helm_release`, pinned chart version): one for the PR jobs, one for the trusted jobs on their own tainted node pool `runners-trusted` |
| GitHub App secret | `infra/access/persistent.tf`, `infra/foundation/runners_secrets.tf` | Secret Manager containers (kept across a destroy), Google SA `arc-secrets`, Workload Identity binding, External Secrets Operator (pinned chart), SecretStore + ExternalSecret |
| Helm values | `k8s/runners/*-values.yaml`, `k8s/runners/github-app-secret/` | static values of the charts and the local chart of the SecretStore / ExternalSecret; Terraform adds the per-environment ones (names, `minRunners` / `maxRunners`, project, cluster) |

Everything is applied by Terraform through the pipeline: a release tag deploys the cluster, then the controller, then
the scale sets, on dev then prd (`deploy.yml` → `deploy-env.yml`), and every PR plans it (`ci-terraform.yml`).
Nothing is installed from a laptop.

### How the pipeline reaches the cluster

The Helm and Kubernetes providers are configured from the cluster outputs, with no kubeconfig file: they target
the **DNS-based endpoint** of the control plane and authenticate with the short-lived OAuth token of the
identity running Terraform. Access through that endpoint is checked by IAM, not by source IP, so the
GitHub-hosted runners of `deploy-env.yml` get in although their IPs are unknown. The IP-based endpoint stays
closed by the (empty) authorized networks.

| Identity | IAM role | What it can do in the cluster |
| --- | --- | --- |
| `gha-deploy` (deploy, destroy) | `roles/container.clusterAdmin` + `roles/container.developer` + custom role `ghaDeployK8sRbac` | create the cluster, install the charts, which create ClusterRoles, Roles and their bindings |
| `gha-plan` (PR plan) | `roles/viewer` | read namespaces, policies and the Helm releases, never the Secrets |

On GKE, `roles/container.developer` cannot create Kubernetes Roles and bindings. `roles/container.admin` could, but
it also carries impersonation (`container.clusters.impersonate`), token creation for Kubernetes service accounts and
CSR approval. The custom role `ghaDeployK8sRbac` (`infra/access/roles.tf`) holds only the 16 permissions on
(Cluster)Roles and (Cluster)RoleBindings. `bind` and `escalate` are part of them: without them no chart could bind
a role with more rights than `roles/container.developer` gives. In practice the deploy account can give itself any right
inside the runners cluster, and nothing outside it; the cluster only hosts the runners.

Helm records its releases in **ConfigMaps** (`helm_driver = "configmap"`), not in Secrets: that is what lets the
read-only plan account refresh them. The values hold no credential: the GitHub App key stays in Secret Manager and in
the Secret that External Secrets writes.

### Order and destroy

Terraform applies cluster + node pool + NAT → namespaces, LimitRange, NetworkPolicy → controller and GitHub App
secret (External Secrets) → scale set. `destroy.yml` walks the same graph backwards: the scale set is uninstalled
while the controller, the GitHub App secret, the nodes and the NAT still exist, so the controller deletes the scale
set registration from GitHub (Settings → Actions → Runners) before being uninstalled itself. No registration is left
behind. The Secret Manager containers are not in this stack: their values survive the destroy, and the next apply
syncs them again.

## GitHub App secret (Secret Manager)

ARC reads the GitHub App id, installation id and private key from the Kubernetes Secret `arc-github-app` in
`arc-runners`. Nobody creates it by hand: [External Secrets Operator](https://external-secrets.io) writes it from
Secret Manager at every deploy, and keeps it in sync (`refreshInterval: 1h`).

```
Secret Manager: arc-github-app-id, arc-github-app-installation-id, arc-github-app-private-key   (infra/access)
        |  roles/secretmanager.secretAccessor on these 3 secrets only
Google SA arc-secrets@<project>.iam.gserviceaccount.com                                          (infra/foundation)
        |  roles/iam.workloadIdentityUser for <project>.svc.id.goog[arc-runners/arc-secrets-reader] only
KSA arc-runners/arc-secrets-reader (no pod runs as it, no automounted token)
        |  TokenRequest by the External Secrets controller, exchanged through GKE Workload Identity
SecretStore gcp-secret-manager + ExternalSecret arc-github-app  -->  Secret arc-github-app  -->  ARC
```

- **No service account key** anywhere: Workload Identity only.
- **No value in Git, tfvars or the Terraform state**: the containers are created by Terraform, the versions are added
  with `gcloud`; `infra/foundation` only reads their metadata (data sources), and no output exposes them.
- **External Secrets is scoped to `arc-runners`** (`scopedNamespace`, `scopedRBAC`): a Role there instead of
  ClusterRoles, only the SecretStore and ExternalSecret reconcilers, no ClusterSecretStore, no PushSecret, no
  webhook. Its own pod (namespace `external-secrets`) has no Google identity.
- **Kept across a destroy**: the containers live in `infra/access/persistent.tf` (dev only, `runners_enabled`), which
  `destroy.yml` never touches. After a destroy + apply the runners come back with no manual step.

### Who can read it (checks)

```bash
# IAM: only arc-secrets reads the secret (plus the project Owners), only one KSA can act as arc-secrets.
gcloud secrets get-iam-policy arc-github-app-private-key --project <project_id>
gcloud iam service-accounts get-iam-policy arc-secrets@<project_id>.iam.gserviceaccount.com

# RBAC: the runner pods (their service account is created by the scale set chart) cannot read Secrets.
kubectl -n arc-runners get pods -o jsonpath='{.items[*].spec.serviceAccountName}'
kubectl auth can-i get secrets -n arc-runners --as=system:serviceaccount:arc-runners:<runner service account>   # no
kubectl auth can-i get secrets -n arc-runners --as=system:serviceaccount:arc-runners:default                   # no
kubectl auth can-i get secrets -n arc-runners --as=system:serviceaccount:arc-runners:arc-secrets-reader        # no
kubectl -n arc-runners get externalsecret arc-github-app      # STATUS SecretSynced, READY True
```

The secret is readable in the cluster by the ARC controller (it copies it for the listener in `arc-systems`) and by
External Secrets, which writes it. A container escape on a runner node could still reach it: that residual risk is
the one already described for the privileged `dind` sidecar (see below).

## Install

1. **Create a GitHub App** on the organization (Repository permissions: Actions read, Administration read and
   write, Metadata read), install it on this repository and download its private key.
2. **Give the deploy account the Kubernetes RBAC role** (`ghaDeployK8sRbac`) by applying
   `infra/access` on the project (Owner needed, see `infra/access/README.md`). The `container` and `cloudresourcemanager` APIs
   are enabled by Terraform (`infra/foundation/apis.tf`).
3. **Deploy** through the usual release flow. The cluster only exists in prd (`runners_enabled = true` in
   `prd.tfvars`, since #55): one cluster (two scale sets) serves the CI of both environments, and dev, which is
   destroyed and re-created for the reproducibility checks, never takes the CI down with it.
4. **Store the GitHub App credentials in Secret Manager, once per project.** A project Owner applies
   `infra/access` (it creates the three empty containers, `runners_enabled = true` in its `prd.tfvars`), then adds
   the values. They go from your shell straight to Secret Manager, never into a file of the repository:

   ```bash
   P=<project_id>
   printf '%s' '<app id>'          | gcloud secrets versions add arc-github-app-id --project "$P" --data-file=-
   printf '%s' '<installation id>' | gcloud secrets versions add arc-github-app-installation-id --project "$P" --data-file=-
   gcloud secrets versions add arc-github-app-private-key --project "$P" --data-file=./app.pem
   rm ./app.pem   # the key now only exists in Secret Manager (GitHub only keeps its fingerprint)
   ```

   This must be done before the deploy that carries #54: `infra/foundation` reads the containers and its plan fails
   while they do not exist. The deploy then syncs them into the cluster; nothing is created with `kubectl`, and a
   destroy keeps them. On a cluster that still has the hand-made `arc-github-app` Secret, External Secrets takes it
   over; if the ExternalSecret reports a conflict instead, delete the old Secret and it is written again at once.
5. **Switch the workflows**, after the fork PR setting of the next section: `scripts/switch-runners.sh self-hosted`
   (see [Switching runners](#switching-runners)). A scale set is selected by its name in `runs-on`.

## Switching runners

Every job of every workflow runs on our runners by default (#55). Two variables, two trust levels, two scale sets:

| Variable | Scale set (prd, `infra/foundation` output) | Nodes | Used by |
| --- | --- | --- | --- |
| `CI_RUNNER` | `huiledecloud-prd-runners` (`runners_scale_set_name`) | `runners` pool, shared with the ARC controller | every PR job: `ci-*`, `pr-title`, `check-source-branch`, `ci-gate`, the Terraform plan |
| `CI_RUNNER_TRUSTED` | `huiledecloud-prd-runners-trusted` (`runners_trusted_scale_set_name`) | `runners-trusted` pool, tainted, 0 node when idle | jobs holding credentials: `deploy` (build), `release`, `architecture`, `wif-isolation`, the `destroy` guard |

There is no fallback in the workflows: an unset variable makes the run fail at once (empty `runs-on`) instead of
running somewhere else. Two ways to go to GitHub-hosted runners, none of them a commit:

- **Everything, for a while** (cluster down, destroy of dev, incident): `scripts/switch-runners.sh github-hosted`
  sets both variables to `ubuntu-latest`; `scripts/switch-runners.sh self-hosted` sets them back to the scale set
  names. Admin on the repository needed (`gh variable set`).
- **One manual run**: `deploy`, `release`, `architecture`, `wif-isolation` and `destroy` have a `runner` input
  (`self-hosted` / `github-hosted`), for example
  `gh workflow run deploy.yml --ref dev -f runner=github-hosted`. A push-triggered run has no input and follows
  `CI_RUNNER_TRUSTED`; `deploy` passes its input to `architecture`.

Where a job ran is in its log, *Set up job* → *Runner name* (`huiledecloud-prd-runners-...` for ours), or with
`gh api repos/Epitechtek5/Cloud/actions/runs/<run id>/jobs --jq '.jobs[] | [.name, .runner_name] | @tsv'`.

The `plan` job of `ci-terraform.yml` stays on `CI_RUNNER` on purpose: it runs the Terraform of the PR (providers,
`external` data sources), so putting it on the trusted pool would run PR code next to the deploy credentials. Fork
PRs are excluded from it, and its service account is read-only (plan). This is an accepted residual risk: a PR
from the repository itself can already change the workflows.

`CI_RUNNER_TRUSTED` must never point to the PR scale set: the trusted runner pods select the `runners-trusted`
nodes (`nodeSelector`) and are the only pods that tolerate their taint (`ci-runners=trusted:NoSchedule`,
`k8s/runners/runner-set-trusted-values.yaml`), so a container escape from a PR job never lands on a node holding
deploy tokens. Both scale sets live in `arc-runners` (the controller watches one namespace), so the LimitRange and
the NetworkPolicy apply to both. A trusted job waits about a minute for its node when the pool is at 0.

### Bootstrap exception: the jobs that create or destroy the cluster

`deploy-env.yml` (the Terraform apply) and the `destroy` job of `destroy.yml` **always run on `ubuntu-latest`**,
whatever the variables and inputs: they create and destroy the runners' own cluster. On its runners, a destroy would
delete the pod running it in the middle of `terraform destroy` (deadlock: the job dies, the state lock stays), and an
apply that replaces the cluster or a node pool would do the same. The `destroy` guard follows the `runner` input,
`github-hosted` by default.

Destroying and re-creating **dev** does not touch the runners: their cluster is in prd. The remaining loop is
**prd** without its cluster (first deploy, or after a destroy of prd): the `deploy` build (trusted pool) would wait
for a runner that does not exist. So:

1. **Before destroying prd**: `scripts/switch-runners.sh github-hosted` (every job would queue otherwise), then run
   `destroy` (`env = prd`, `runner = github-hosted`, the default).
2. **First deploy, or re-creation of prd**: with the variables on `ubuntu-latest`, the release tag deploys as usual;
   or, without touching the variables, `gh workflow run deploy.yml --ref <vX.Y.Z tag> -f runner=github-hosted`
   (still behind the prd reviewers).
3. **Once the deploy is green** (`kubectl -n arc-systems get pods` shows both listeners):
   `scripts/switch-runners.sh self-hosted`.

### Moving the cluster from dev to prd (once, #55)

The cluster used to live in dev. Setting `runners_enabled = false` in dev cannot be applied as is: the Helm and
Kubernetes providers lose their cluster host in the same plan that has to uninstall the releases, so the plan
fails. The move is therefore done with a destroy of dev, which uses the hosts recorded in the state:

1. **CI on GitHub-hosted runners** for the whole move: `scripts/switch-runners.sh github-hosted` (already the case
   while `CI_RUNNER` is `ubuntu-latest`).
2. **prd Secret Manager** (project Owner): apply `infra/access` on prd (`runners_enabled = true` in its `prd.tfvars`
   creates the three containers), then copy the values from dev, straight from one project to the other:

   ```bash
   for s in arc-github-app-id arc-github-app-installation-id arc-github-app-private-key; do
     gcloud secrets versions access latest --secret "$s" --project sage-inquiry-512409-h3 \
       | gcloud secrets versions add "$s" --project huiledecloud-cloudnative-prd --data-file=-
   done
   ```

   Until then the PR plan of `prd / foundation` fails: `infra/foundation` reads the containers.
3. **Destroy dev before merging**, with the code that still has the cluster there:
   `gh workflow run destroy.yml --ref dev -f env=dev -f confirm=destroy-dev`. The controller removes the dev scale
   sets from GitHub on the way.
4. **Merge**: the deploy of `dev` re-creates dev without any runner.
5. **Release**: the tag deploys prd, cluster and scale sets included, on GitHub-hosted runners.
6. **Switch**: `scripts/switch-runners.sh self-hosted` once both listeners are up in prd.
7. **Clean up dev** (project Owner): apply `infra/access` on dev (`runners_enabled = false` now) to delete the
   three old containers. Only after step 3: the destroy of dev reads them.

## How it covers the runner guardrails

| Requirement of [runner-guardrails.md](runner-guardrails.md) | Implementation |
| --- | --- |
| Ephemeral runners | ARC scale sets: one pod per job, deleted at the end |
| Bounded fleet | `runners_max_runners` (scale set `maxRunners`) and `runners_max_nodes` (node pool ceiling) |
| Idle TTL | `runners_min_runners = 0` (no runner pod when idle); the node pool keeps `runners_min_nodes` (1) node for the ARC controller |
| Least-privilege service account | dedicated node service account with `container.defaultNodeServiceAccount` only |
| Trusted jobs isolated from PR jobs | second scale set on the tainted `runners-trusted` node pool (`runners_trusted_max_nodes`, `runners_trusted_max_runners`, from 0 node) |
| Dedicated subnet | nodes in the `runners` subnet, no public IP |
| No access to the node identity | `GKE_METADATA` (Workload Identity): pods cannot use the node service account |
| Contained network | NetworkPolicy: ingress denied, egress to the internet only (no private ranges) |
| No exposed credential | GitHub App key in Secret Manager, synced by External Secrets through Workload Identity (no SA key); only the `arc-secrets` SA reads it, only one KSA can act as that SA |

Still to do outside this change: the fork PR setting below.

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
HELM_DRIVER=configmap helm -n arc-runners list          # installed scale sets (releases are in ConfigMaps)
kubectl get nodes -L purpose                            # ci-runners and, while a trusted job runs, ci-runners-trusted
```

- **Scale**: change `runners_max_runners` (and `runners_max_nodes` first, see the sizing note in
  `k8s/runners/runner-set-values.yaml`) in the tfvars, then release.
- **Upgrade ARC or the runner**: bump `runners_arc_version` (both charts move together) or the image tag in
  `runner-set-values.yaml`, then release. The PR plan shows the Helm diff. Same for External Secrets with
  `runners_eso_version`.
- **Rotate the GitHub App private key** (no downtime: a GitHub App accepts several keys at once). Same procedure for
  the app id or the installation id (after a reinstall of the app):
  1. GitHub → organization settings → GitHub Apps → the runners app → *Generate a private key*.
  2. Add it as a new version: `gcloud secrets versions add arc-github-app-private-key --project <project_id>
     --data-file=./new.pem`, then delete the local file.
  3. Sync without waiting for the hourly refresh, then restart the listener so it signs with the new key (the
     controller recreates it):

     ```bash
     kubectl -n arc-runners annotate externalsecret arc-github-app force-sync="$(date +%s)" --overwrite
     kubectl -n arc-runners get externalsecret arc-github-app          # SecretSynced
     kubectl -n arc-systems delete pod -l app.kubernetes.io/component=runner-scale-set-listener
     ```

  4. Check that a job runs, then delete the old key in GitHub and disable the old version
     (`gcloud secrets versions disable <old version> --secret arc-github-app-private-key --project <project_id>`).
     A leaked key is rotated the same way, deleting the old key in GitHub right after step 2.
- **Spot preemption**: a job running on a preempted node fails and must be re-run. The ARC controller and
  listener run on the same Spot node: when it is preempted, queued jobs wait until they are rescheduled. Set
  `runners_spot = false` if that becomes a problem.
- **Docker in the runner**: jobs get a `dind` sidecar (needed for container actions), which runs privileged
  inside the pod. This is acceptable because pods are ephemeral and isolated by the network policy, as long as
  fork PRs require approval (see above).
