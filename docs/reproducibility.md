# Reproducible and disposable infrastructure

Subject 2.2 (C02 §6, Hands-on 1 acceptance), issue #56: an environment is created by `deploy` (apply) and removed by
`destroy` with no manual step, and after a destroy **nothing billable is left except the human-access stack and the
state bucket**. This page is what we show live at the defense: what is kept and why, how to run the cycle, how to
prove nothing is left, and the results.

## What a destroy removes, what it keeps

`destroy.yml` destroys `infra/serverless`, then `infra/foundation` (the reverse of the deploy), then removes what GCP
created on their behalf, then runs `scripts/check-leftovers.sh`, which fails the run if anything unexpected is left.

| Kept on purpose | Stack | Why | Cost when idle |
| --- | --- | --- | --- |
| State bucket `<project>-tfstate` | `scripts/bootstrap-state-bucket.sh` | Holds the states the next apply starts from | a few KB |
| WIF pool and provider, `gha-deploy`, `gha-plan`, roles, people | `infra/access` | Without them the pipeline cannot deploy again and nobody can sign in | free |
| Budget alerts | `infra/billing` | Must watch the bill even while nothing runs | free |
| Global address `frontend` | `infra/access` (`persistent.tf`) | The dev URL `<ip>.sslip.io`, its certificate and the Discord OAuth2 redirect URIs derive from it: a new IP would mean editing `dev.tfvars` and the Discord portal by hand | about 7 USD/month while unattached |
| Secret containers `discord-*` | `infra/access` (`persistent.tf`) | Their values are added by hand and never stored in Git or in a state; destroyed, they would be lost and the next apply would fail (a function cannot start on a secret with no version) | free (Secret Manager: 6 active versions free) |
| Secret containers `arc-github-app-*` (dev) | `infra/access` (`persistent.tf`) | GitHub App of the runners: External Secrets copies them into the new cluster at every apply, so the runners come back with no `kubectl create secret` (#54) | free (3 more active versions) |

APIs are never disabled (`disable_on_destroy = false`) and the `default` VPC created with the project is left alone:
both are free.

## Leaks found and fixed

| Leak | Effect | Fix |
| --- | --- | --- |
| Discord secret values destroyed with `infra/serverless` | Next apply fails: `auth-discord` cannot start on an empty secret | Containers moved to `infra/access`; `infra/serverless` reads them (data sources) and gave them up with a `removed` block (`destroy = false`) |
| Runners GitHub App secret created by hand in the cluster | Deleted with the namespace: runners stayed offline until someone ran `kubectl create secret` | Values in Secret Manager (`infra/access`), synced by External Secrets through Workload Identity (#54, [self-hosted-runners.md](ci/self-hosted-runners.md)) |
| Frontend IP released by the destroy | New sslip.io host: `dev.tfvars` and the Discord portal had to be edited by hand | Address moved to `infra/access`, same name, so the IP does not change |
| `gcf-v2-sources-<number>-<region>` (and `gcf-v2-uploads-*`) buckets | Created by Cloud Functions 2nd gen outside Terraform, left after a destroy | Removed by a step of `destroy.yml` |
| Build of the first function started before the IAM grants of the (recreated) `fn-build` account propagated | `Access to bucket gcf-v2-sources-... denied`, function left `FAILED`, deploy red | The functions wait for `time_sleep.functions_build_iam` (90 s, only when a grant is created) (#138) |
| Tainted function replaced with `create_before_destroy`, forced by the api config reading `module.<function>.uri` | `409 ... already exists`: the function had to be deleted by hand | The gateway builds the deterministic Cloud Run URL of each function from its name (#138) |

Already fine, checked in the code: GKE has `deletion_protection = false`; Firestore uses `deletion_policy = "DELETE"`
with delete protection on prd only; every dev bucket has `force_destroy` (the snapshots bucket refuses it on prd only);
Cloud NAT uses auto-allocated IPs, released with it; the runner nodes have no extra disks and no Kubernetes
`LoadBalancer` service or `PersistentVolumeClaim` exists (ARC only); the functions use our own Artifact Registry
repository `functions` (no `gcf-artifacts` repository is created).

## One-time migration (after the merge of #56)

The address and the secrets move from the serverless state to the access state without being recreated:

1. Merge to `dev`: the dev deploy runs the `removed` blocks, `infra/serverless` forgets them (the plan shows
   "will no longer be managed by Terraform, but will not be destroyed").
2. A project Owner adopts them in `infra/access` and applies (see `infra/access/README.md`):

   ```bash
   terraform -chdir=infra/access init -reconfigure -backend-config=backends/dev.hcl
   infra/access/import.sh dev
   terraform -chdir=infra/access apply -var-file=dev.tfvars -var-file=dev.local.tfvars   # expect no change
   ```

3. prd, done on 2026-11-27 **before** the release, because the prd plan of `dev` had a cycle (the `forget` of the
   secrets and the replacement of the api config that still depended on them in the state): `import.sh prd`, an
   apply of `infra/access` targeted on the adopted resources (an Owner without rights on the billing account cannot
   plan `instructor_billing`), then `terraform state rm google_compute_global_address.frontend
   google_secret_manager_secret.this` in the prd serverless state (backed up first), which is what the `removed`
   blocks do. The `plan (prd, serverless)` check is green again.

## Procedure (dev)

Since #55 the runners cluster lives in prd: destroying dev no longer touches the CI, which keeps running on our
runners during the whole cycle (a destroy of prd does need the switch, see the
[runners doc](ci/self-hosted-runners.md#bootstrap-exception-the-jobs-that-create-or-destroy-the-cluster)). Tell the
team before starting: a merge to `dev` during the destroy queues a deploy (same concurrency group) that re-creates dev as
soon as the destroy ends (it happened in cycle 2).

1. **Destroy**: Actions → `destroy` → Run workflow on `dev`, `env = dev`, `confirm = destroy-dev`.

   ```bash
   gh workflow run destroy.yml --ref dev -f env=dev -f confirm=destroy-dev
   ```

   The run ends with the `Check that nothing billable is left` step. Run it again by hand at any time:

   ```bash
   scripts/check-leftovers.sh sage-inquiry-512409-h3
   ```

   Expected: every line `none`, then `Nothing left but the state bucket and the access stack.` (exit 0). The billing
   report (Billing → Reports, group by SKU, project dev) then shows only Cloud Storage and the static IP.

2. **Apply again**: re-run the last `deploy` run of `dev` (it rebuilds the artifact and applies `foundation` then
   `serverless`):

   ```bash
   gh run rerun "$(gh run list --workflow deploy.yml --branch dev --limit 1 --json databaseId -q '.[0].databaseId')"
   ```

   The first apply of an environment takes about 15 minutes (the API Gateway alone about 10). The managed certificate
   takes up to an hour to become `ACTIVE` again: if the smoke test is red only on `app_url`, re-run the deploy job
   once `gcloud compute ssl-certificates list` shows `ACTIVE`.

3. **Check**: `terraform plan` of both stacks shows no change, the app answers on the same `app_url`.

4. Repeat 1 to 3 a second time (acceptance: apply → destroy → apply twice in a row).

### What still needs a person after a re-apply

Outside GCP, so out of Terraform's reach:

- **API Gateway host**: it stayed `pixel-canvas-7oi57k6.ew.gateway.dev` across both cycles (same gateway id in the
  same project), so the Discord Activity URL mapping `/api` was kept. If it ever changes, update that mapping and,
  once `discord-proxy` is on, the Interactions Endpoint URL (`terraform output discord_interactions_url`).
- **Data**: the dev Firestore database and buckets start empty (dev is disposable; prd has delete protection and
  PITR).

## GitHub environments

Checked with `gh api repos/Epitechtek5/Cloud/environments/<env>` and `.../deployment-branch-policies`:

| Environment | Deployment branches and tags | Protection |
| --- | --- | --- |
| `dev` | branch `dev`, tags `v*` | none (the deploy of `dev` runs on every push) |
| `prd` | tags `v*` only | required reviewers (Zeishy, Raphael-Clenet, Quentintnrl), self-review prevented |

The WIF provider of each project only accepts jobs of the matching Environment (`infra/access/README.md`), so a job
that bypasses these rules still cannot get credentials for the other environment.

## Results

Run on dev on 2026-11-27, after #134 and #138, with no manual step between the runs.

| Cycle | Destroy run | Leftover check | Apply run | Notes |
| --- | --- | --- | --- | --- |
| 1 | [46018414181](https://github.com/Epitechtek5/Cloud/actions/runs/46018414181): 100 (serverless) + 19 (foundation) destroyed, 18 min | every line `none` (in the run and by hand) | [46016502936](https://github.com/Epitechtek5/Cloud/actions/runs/46016502936) (re-run): 19 + 100 added, 21 min, smoke tests green | Same IP `136.68.161.49`, same gateway host, certificate `ACTIVE` at the end of the apply |
| 2 | [46025167228](https://github.com/Epitechtek5/Cloud/actions/runs/46025167228): 100 + 19 destroyed, 18 min | Red in the run: 3 `arc-github-app-*` secrets. They are kept on purpose since #136 (#54), merged during the run, which also added them to `KEEP_SECRETS`; the run used the script from before. 0 unexpected with the current script | [46027562838](https://github.com/Epitechtek5/Cloud/actions/runs/46027562838) (push of #142, queued behind the destroy): 28 + 100 added, 21 min, smoke tests green | First apply with #136: the runners' GitHub App secret came from Secret Manager, no `kubectl` |
