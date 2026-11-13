# infra/billing

Monthly budget alert on one project (subject 2.3, C04 §4.4). One state per environment (prefix `billing`).

This stack is **not** applied by the pipeline and is never destroyed by `destroy.yml`. The guard rail survives a
destroy of the workload, and the CI service accounts don't need any role on the billing account.

| File | Content |
|---|---|
| `main.tf` | Required APIs, one Cloud Monitoring email channel per address, the `google_billing_budget` |
| `<env>.tfvars` | Project, environment, `budget_amount` (committed) |
| `<env>.local.tfvars` | `billing_account`, `notification_emails` (git-ignored, see `local.tfvars.example`) |

The budget:

- watches **only the project** of the environment, monthly;
- **excludes credits**. With free-trial credits deducted, the spend stays at 0 and no alert ever fires. Excluded,
  the budget tracks how fast the credits are burnt;
- alerts at 50 %, 90 % and 100 % of actual spend, and at 100 % of forecasted spend (`budget_thresholds`);
- notifies the billing account admins (default emails) and each address in `notification_emails`.

A budget only **alerts**. It never stops a resource.

## Apply

You need **Billing Account Administrator** (or **Billing Account Costs Manager**) on the billing account, and Owner or
Editor on the project. Example for dev:

```sh
gcloud auth application-default login
cp infra/billing/local.tfvars.example infra/billing/dev.local.tfvars   # then fill it in
terraform -chdir=infra/billing init -backend-config=backends/dev.hcl
terraform -chdir=infra/billing apply -var-file=dev.tfvars -var-file=dev.local.tfvars
```

For prd, use `backends/prd.hcl` with `prd.tfvars` and `prd.local.tfvars`. After switching environments, run
`init -reconfigure`.

Check: console, Billing, **Budgets & alerts**. Both `huiledecloud-dev-monthly` and `huiledecloud-prd-monthly` are
listed.

## Test notification

Budgets have no "send test" button. Temporarily lower the amount below the current gross spend of the month:

```sh
terraform -chdir=infra/billing apply -var-file=dev.tfvars -var-file=dev.local.tfvars -var=budget_amount=1
```

GCP evaluates budgets several times a day, so the email can take a few hours. Once it reaches the team, apply again
without `-var=budget_amount=1`. Run this test on dev. prd may have no spend yet, and then no threshold is crossed.

## Discord

A budget can't call a webhook. To post to Discord, set `all_updates_rule.pubsub_topic` and add a function that
forwards the Pub/Sub message to the webhook. That is not done here: the email channels cover the issue.
