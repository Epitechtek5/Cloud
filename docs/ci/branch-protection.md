# Branch protection for `main`

`ci-gate` is the **only** required status check. It waits for `ci-security` and for every path-filtered CI
workflow that the PR touches (`ci-terraform`, `ci-functions`, `ci-frontend`), and fails if any of them fails.
Workflows that are not triggered by the PR's paths are not expected, so they cannot block the merge.

Keep the `filters` in `ci-gate.yml` in sync with the `paths` of each CI workflow.

## Settings to apply (admin required)

On `main`:

- Require a pull request before merging, with at least 1 approving review.
- Require status checks to pass: `ci-gate` only.
- Do not allow bypassing the above settings.

`check-source-branch` already restricts PRs to `main` to the `dev` branch.

As a ruleset, via the API (review the payload before running it):

```bash
gh api repos/Epitechtek5/Cloud/rulesets -X POST --input - <<'JSON'
{
  "name": "main-protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    { "type": "pull_request", "parameters": { "required_approving_review_count": 1, "dismiss_stale_reviews_on_push": true, "require_code_owner_review": false, "require_last_push_approval": false, "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": { "strict_required_status_checks_policy": false, "required_status_checks": [ { "context": "ci-gate" } ] } }
  ]
}
JSON
```

The `release` workflow pushes tags, not commits, to `main`, so it is not affected by these rules.
