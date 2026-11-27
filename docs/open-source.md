# Open-source components

Subject 5.4 and 5.6, issue #78: every third-party component of the project (action, chart, image, Terraform provider,
library, tool, external service) is justified in a table, with its version, what it does for us and why we trust it. The
tables live next to the track that uses the component, so that the person who chose it keeps them true; this page is
the entry point, the shared rules, and the check that nothing is missing.

| Track | Table | Covers |
| --- | --- | --- |
| Infra | [`open-source-infra.md`](open-source-infra.md) | GitHub Actions, Helm charts and images of the runners, Terraform providers, CI tools installed by the workflows, scripts, external services (sslip.io, Anthropic API) |
| Cloud functions | [`open-source-functions.md`](open-source-functions.md) | runtime and development libraries of `app/functions`, tools run by `npx`, the emulator |
| Front | [`open-source-frontend.md`](open-source-frontend.md) | runtime and build libraries of `app/frontend`, services the browser talks to |
| Shared | this page, below | what no track owns: the tests of the Firestore rules |

## Rules every component follows

- **Official first.** A Google, GitHub, HashiCorp or CNCF component over a community one; no dependency when the
  platform does the job (Node's standard library, Terraform's built-in functions). The exceptions are named and justified
  in their table.
- **Pinned where it changes what is deployed.** Terraform providers by the `.terraform.lock.hcl` of each stack, npm
  packages by the committed `package-lock.json` (CI installs with `npm ci`), charts and images by exact version, tools
  downloaded by a workflow by exact version (gitleaks also by checksum).
- **Audited on every pull request.** `npm audit` fails the PR on a high or critical advisory, with the justified,
  expiring exceptions of [`ci/dependency-audit.md`](ci/dependency-audit.md); `ci-security` runs gitleaks (blocking) and
  Semgrep; `ci-terraform` runs checkov and tflint.
- **Least privilege for the job that uses it.** Workflows default to `permissions: contents: read`; `id-token: write`
  is only on the jobs that authenticate to GCP, and secrets only in the jobs that need them.
- **Licences are recorded** in the tables of the npm packages, so that compatibility with the repository can be checked
  at a glance.
- **A new dependency comes with its row**, in the same pull request, in the table of the track that owns it.

## Shared: tests of the Firestore rules

`infra/serverless/tests/firestore-rules/package.json` is a Node project of its own (the emulator tests of
`firestore.rules`, run by `ci-firestore-rules`), so it belongs to no track table. Facts checked on 2026-11-27 with
`npm view <package@version> license time`.

| Package | Version | Licence | Released | Used for | Why it is safe and maintained |
| --- | --- | --- | --- | --- | --- |
| `@firebase/rules-unit-testing` | 6.0.0 | Apache-2.0 | 2026-10-07 | Starts the rules against the emulator as an anonymous or authenticated user and checks what is allowed or refused | Official Firebase package (`firebase/firebase-js-sdk`), the documented way to test rules; devDependency, never deployed |
| `firebase` | 13.3.0 | Apache-2.0 | 2026-11-11 | Client SDK the test uses to issue the reads and writes | Official Google SDK, same monorepo; devDependency of the tests only |
| `firebase-tools` | 15.36.0 | MIT | 2026-11-11 | `firebase emulators:exec`: starts the Firestore emulator, runs the tests, stops it | Official Firebase CLI. The same exact version is run by `npx` for the functions tests (see [`open-source-functions.md`](open-source-functions.md)); it never ships in a function |

The emulator jar is cached by `actions/cache` and run with Java 21 (`actions/setup-java`), both listed in
[`open-source-infra.md`](open-source-infra.md).

## Check that nothing is missing

Acceptance of #78: every dependency of the workflows, the charts and Terraform appears in a table. These commands list
what to compare with the tables; run them before the defense and after any dependency change.

```bash
# GitHub Actions used by the workflows (compare with "GitHub Actions" in open-source-infra.md)
grep -rhoE 'uses: [^ ]+' .github/workflows | sort -u

# Terraform providers, as pinned by the lock files (compare with "Terraform providers")
grep -h '^provider ' infra/*/.terraform.lock.hcl | sort -u

# Helm charts and images of the runners (compare with "Kubernetes: charts and images")
grep -rnE 'chart *=|repository *=|version *=|image' infra/foundation/runners.tf k8s/runners

# npm runtime and development packages of each project, after `npm ci` in it (compare with the tracks' tables)
npm --prefix app/functions ls --depth=0
npm --prefix app/frontend ls --depth=0
npm --prefix infra/serverless/tests/firestore-rules ls --depth=0

# Tools downloaded or run by a workflow (compare with "CI tools installed by the workflows")
grep -rnE 'npx|curl|wget|pip install' .github/workflows scripts
```

A line in the output with no row in a table is a gap: add the row (version, licence, use, why it is safe), in the table of
the track that owns it.

## External services

Components that are not code we run but services the system calls. Each is justified in the table of the track that
calls it; this is the whole list, to answer "what do you depend on outside GCP?".

| Service | Called by | Sends it | Where justified |
| --- | --- | --- | --- |
| Discord (API, OAuth2, Activity proxy) | the proxy and workers (interactions, follow-ups), the login function, the front | slash command interactions, OAuth2 code exchange (`identify` scope only), webhook follow-ups | [`discord-bot.md`](discord-bot.md), [`discord-activity.md`](discord-activity.md), [`open-source-frontend.md`](open-source-frontend.md) |
| GitHub (Actions, OIDC, Apps, API) | the pipeline | the repository, the OIDC token (exchanged for a 1 h Google token), the release and runner GitHub Apps | [`open-source-infra.md`](open-source-infra.md), [`infra-security.md`](infra-security.md) |
| sslip.io | the browsers, the certificate | nothing: it resolves `<a-b-c-d>.sslip.io` to the IP it contains | [`open-source-infra.md`](open-source-infra.md), "External services" |
| Anthropic API | the `architecture` workflow only | Terraform addresses, types and names of the deployed resources, no attribute value | [`open-source-infra.md`](open-source-infra.md), "External services" |
