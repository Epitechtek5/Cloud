# Dependency audit and false positives

`ci-frontend` runs `npm audit --omit=dev --audit-level=high` and fails on any `high` or `critical`
advisory in production dependencies. `ci-functions` does the same without any exception mechanism.

## Handling an advisory

1. **Fix it.** Upgrade the dependency, or pin a patched transitive version with `overrides` in `package.json`.
2. **Only if it is a real false positive** (the vulnerable code path is not reachable), declare an exception
   in `app/frontend/audit-exceptions.json` through a reviewed PR:

   ```json
   [
     {
       "id": "GHSA-xxxx-xxxx-xxxx",
       "justification": "Why this does not apply to us (which code path, why unreachable).",
       "expires": "2026-12-31"
     }
   ]
   ```

   - `id` is the GHSA identifier shown in the audit report.
   - `justification` is mandatory and is reviewed like code.
   - `expires` (`YYYY-MM-DD`) is mandatory. After that date the exception is ignored and the CI fails again,
     so an exception cannot be forgotten.
3. Never disable the audit step, add `|| true`, or lower `--audit-level`.

The job prints a warning when it passes only because of an exception, so the exception stays visible in the logs.
