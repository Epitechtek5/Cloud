# Runner guardrails

Every job runs on our **self-hosted runners** by default, selected through two repository variables:
`runs-on: ${{ vars.CI_RUNNER }}` for the PR jobs and `vars.CI_RUNNER_TRUSTED` for the jobs that hold credentials
(issue #55, see [self-hosted-runners.md](self-hosted-runners.md#switching-runners)). The cost is the GCP VMs and the
risk is the code they run, not GitHub-hosted minutes.

## In place (workflows)

| Guardrail | Where | Why |
| --- | --- | --- |
| `timeout-minutes` on every job | all workflows | the default is 360 min: a hung job would hold a runner (and its VM) for 6 hours |
| `concurrency` with `cancel-in-progress: true` | PR workflows | a new push cancels the superseded run |
| `concurrency` without cancellation | `deploy-env`, `destroy`, `release` | never interrupt a Terraform apply or a release |
| `paths:` filters | `ci-frontend`, `ci-functions`, `ci-terraform` | only run when the relevant files change |
| typed confirmation | `destroy` | `destroy-<env>` must be typed |

`ci-security` has no path filter on purpose: a secret can land anywhere.

Timeouts: 5 min for trivial checks, 10-15 min for lint, tests, audits and diagrams, 20 min for the Terraform
plan, 30 min for deploy and destroy. Raise a value in the workflow when a job legitimately needs more.

## To set up with the runners

These cannot be enforced from the workflows and must be part of the runner infrastructure
(most of them are implemented by [self-hosted-runners.md](self-hosted-runners.md)):

- **Ephemeral runners**: one job per VM, destroyed afterwards. No state or credentials shared between jobs.
- **Bounded fleet**: a maximum number of instances and an idle TTL on the autoscaler, so a burst of PRs cannot
  create an unbounded number of VMs.
- **No fork PRs**: Settings, Actions, "Require approval for all outside collaborators". A fork PR runs arbitrary
  code on the runner network.
- **No `pull_request_target`** that checks out the code of the PR.
- **Least-privilege service account** on the runner VMs, and the runners kept in the dedicated `runners` subnet
  of the prd VPC (the cluster lives in prd since #55, so the reproducibility cycles on dev never take it down).
- **Trusted jobs on their own nodes**: the jobs holding credentials use a second scale set whose pods only run on a
  tainted node pool, never next to a PR job.
- **Budget alert**: done, a monthly `google_billing_budget` per project (credits excluded) alerting the team at
  50, 90 and 100 % of actual spend and 100 % of forecasted spend. See [infra/billing](../../infra/billing/README.md).

## No silent fallback to GitHub-hosted runners

The `|| 'ubuntu-latest'` fallback is gone (#55): if `CI_RUNNER` or `CI_RUNNER_TRUSTED` is unset, `runs-on` is empty
and the run fails at once instead of quietly running on GitHub-hosted machines. Going back to GitHub-hosted runners
is an explicit choice: set the variables to `ubuntu-latest` (`scripts/switch-runners.sh github-hosted`), or pick
`runner = github-hosted` when running a manual workflow.
