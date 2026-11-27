# Open-source components: cloud functions track

Subject 5.4 / 5.6: every third-party component the functions track relies on, with its version, what it does for us
and why we trust it. The infra and front tracks list theirs in their own files; the shared index (`docs/open-source.md`,
#78) links the three.

Selection rules applied:

- **Official first**: a Google or CNCF-maintained library over a community one, and no dependency when Node's standard
  library does the job (HTTP via `fetch`, PNG via `node:zlib`, Ed25519 via `node:crypto`, tests via `node:test`).
- **Pinned by the lockfile**: `package-lock.json` is committed and CI installs with `npm ci`, so the deployed tree is
  the reviewed one. Ranges in `package.json` (`^`) only matter when someone runs `npm install`.
- **Audited on every PR**: `ci-functions.yml` job `audit` runs `npm audit --omit=dev --audit-level=high`; it fails the
  PR on a high or critical advisory. 0 vulnerabilities at the time of writing.
- **Licences**: Apache-2.0 or MIT only, both compatible with a public repository.

## Runtime libraries (`app/functions/package.json`)

| Package | Version | Licence | Used for | Why it is safe and maintained |
| --- | --- | --- | --- | --- |
| `@google-cloud/firestore` | 9.4.1 | Apache-2.0 | Transactions of the workers (pixels, quotas, idempotency markers), reads of `pixel-reader` and `snapshot-worker` | Official Google client (googleapis/google-cloud-node), released several times a month, authenticates with the function's own service account (no key) |
| `@google-cloud/pubsub` | 6.4.1 | Apache-2.0 | `publisher.js`: every event published by the proxies and workers | Official Google client, same monorepo and release process |
| `@google-cloud/storage` | 9.0.0 | Apache-2.0 | Create-only upload of snapshots, V4 signed URLs (`signBlob`, no key file) | Official Google client |
| `@google-cloud/secret-manager` | 8.0.0 | Apache-2.0 | Reads the Discord public key and OAuth2 secret at runtime, cached per instance | Official Google client. Secrets never transit through env vars or the repo |
| `@opentelemetry/api` | 1.9.1 | Apache-2.0 | Span API used by `src/lib/trace.js` (no-op without the SDK) | CNCF OpenTelemetry project. Stays on 1.9 because `@opentelemetry/core` 2.x declares `api <1.10` |
| `@opentelemetry/core`, `resources`, `sdk-trace-base`, `sdk-trace-node` | 2.12.1 | Apache-2.0 | SDK started on Cloud Run (`src/lib/otel.js`): W3C propagation, sampling, batching | CNCF OpenTelemetry JS, stable 2.x line, monthly releases |
| `@google-cloud/opentelemetry-cloud-trace-exporter` | 3.1.0 | Apache-2.0 | Exports the spans to Cloud Trace | Maintained by Google (GoogleCloudPlatform/opentelemetry-operations-js), recommended by the Cloud Trace docs |
| `@google-cloud/opentelemetry-cloud-trace-propagator` | 0.22.0 | Apache-2.0 | Reads `X-Cloud-Trace-Context` sent by Cloud Run and the API Gateway, so their spans and ours share one trace | Same Google repository. 0.x version but stable API, released with the exporter |

Transitive dependencies (about 200, mostly `google-gax`, `gRPC`, `google-auth-library`) come from these clients only
and are covered by the same audit.

Not a dependency: `@google-cloud/functions-framework`. The Cloud Functions build provides it (`gcp-build` is empty),
and `src/index.js` only exports handlers.

## Test and build tooling

| Tool | Version | Licence | Used for | Why |
| --- | --- | --- | --- | --- |
| `node:test`, `node --check` | Node 22 | MIT | Unit tests, coverage thresholds (90 % lines), lint | Built into Node: no test framework to keep up to date |
| `firebase-tools` | 15.36.0 (exact, via `npx`) | MIT | Firestore emulator for the transaction tests (`npm run test:emulator`, `test:ci`) | Official Firebase CLI. Run with `npx` at an exact version, never installed in the deployed package. The emulator only binds to localhost |
| Java (Temurin) | 21 | GPLv2 + CE | Runtime of the Firestore emulator in CI | Installed by `actions/setup-java`, CI only |

## GitHub Actions used by `ci-functions.yml`

| Action | Version | Used for | Why |
| --- | --- | --- | --- |
| `actions/checkout` | v4 | Checkout | Official GitHub action |
| `actions/setup-node` | v4 | Node 22 and the npm cache | Official GitHub action |
| `actions/setup-java` | v4 | Java 21 for the emulator | Official GitHub action |
| `actions/cache` | v4 | Caches `~/.cache/firebase/emulators` (the emulator jar) | Official GitHub action |
| `actions/upload-artifact` | v4 | Keeps `functions.zip` of a PR for inspection | Official GitHub action |

These are all published by GitHub itself and referenced by major tag, like every workflow of the repository. Pinning to
a commit SHA is a repository-wide decision covered by the infra track (#80).

## Terraform (functions part of `infra/serverless`)

| Component | Version | Used for | Why |
| --- | --- | --- | --- |
| `hashicorp/google` | `~> 7.0` | Functions, Pub/Sub, Firestore, buckets, IAM, log metrics, dashboard | Official HashiCorp/Google provider |
| `hashicorp/google-beta` | `~> 7.0` | API Gateway (beta-only resources) | Same provider, beta channel |
| `hashicorp/archive` | `~> 2.7` | Local fallback zip of `app/functions` when no CI artifact is given | Official HashiCorp provider |
| Modules `function`, `pubsub`, `dashboard` | in repo | One function with its SA and invokers; a channel with its subscription and DLQ; the application dashboard | Written by us, each with `terraform test` run by `ci-terraform` |

No third-party Terraform module is used.

## External APIs called at runtime

| API | By | Authentication |
| --- | --- | --- |
| Discord interactions webhooks (`discord.com/api/v10/webhooks/...`) | command worker, draw worker, snapshot notifier | The interaction token (15 min). No bot token is stored |
| Discord OAuth2 (`/oauth2/token`, `/users/@me`) | `auth-discord` | Client secret from Secret Manager |
| Google APIs (Firestore, Pub/Sub, Storage, IAM Credentials, Secret Manager, Cloud Trace) | every function | The function's own service account through the metadata server: no key file anywhere |
