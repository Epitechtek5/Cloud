# Runner guardrails

The CI/CD targets **self-hosted runners**, selected through the `CI_RUNNER` repository variable
(`runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}`). The cost is the GCP VMs and the risk is the code they run,
not GitHub-hosted minutes.

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

These cannot be enforced from the workflows and must be part of the runner infrastructure:

- **Ephemeral runners**: one job per VM, destroyed afterwards. No state or credentials shared between jobs.
- **Bounded fleet**: a maximum number of instances and an idle TTL on the autoscaler, so a burst of PRs cannot
  create an unbounded number of VMs.
- **No fork PRs**: Settings, Actions, "Require approval for all outside collaborators". A fork PR runs arbitrary
  code on the runner network.
- **No `pull_request_target`** that checks out the code of the PR.
- **Least-privilege service account** on the runner VMs, and the runners kept in the dedicated `runners` subnet.
- **Budget alert**: a `google_billing_budget` with notifications on the project.

## Fallback to GitHub-hosted runners

While `CI_RUNNER` is unset, jobs silently fall back to `ubuntu-latest`. Once the self-hosted runners are live,
set `CI_RUNNER` and remove the `|| 'ubuntu-latest'` fallback from every workflow so that a missing runner fails
instead of running on GitHub-hosted machines.
