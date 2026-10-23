# Secret scanning and SAST

## gitleaks (blocking)

`ci-security` runs the official gitleaks binary (checksum verified) on:

- every PR: only the commit range `base..head` of the PR;
- every push to `main`: the full history.

`.gitleaks.toml` extends the default ruleset with an empty allowlist. Any entry added there must be commented
(what, why it is safe) and approved in review. If a real secret leaked, rotate it first: removing it from the
code does not remove it from the history.

## Semgrep (non-blocking)

Rules `p/javascript`, `p/typescript` and `p/nodejs` on `app/functions` and `app/frontend`. The job uses
`continue-on-error` until the first findings are triaged. To make it blocking, remove that line.

## GitHub-side protections (repository settings)

Enable secret scanning and push protection (admin required):

```bash
gh api repos/Epitechtek5/Cloud -X PATCH \
  -F 'security_and_analysis[secret_scanning][status]=enabled' \
  -F 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
```

## Validating the check

Open a throwaway PR adding a dummy credential (for example a fake AWS key `AKIA` followed by 16 uppercase
characters). The `gitleaks` job must fail. Close the PR without merging.
