# Open-source components: front track

Subject 5.4 / 5.6, issue #82: every third-party component the front track relies on, with its version, what it does for us
and why we trust it. The functions track lists theirs in `open-source-functions.md` (#81) and the
infra track in `open-source-infra.md` (#80); the shared index `docs/open-source.md` (#78) links the three.

Facts below were checked on 2026-11-27: versions come from `app/frontend/package-lock.json`, release dates and
deprecation status from `npm view <package> time` (the date is the release of **the version we use**), licences from the
lockfile. Components arriving with PR #139 (GCP adapter, not on `dev` yet) are marked **(#139)**.

Selection rules applied:

- **Few runtime dependencies.** The app ships one runtime package today (the Discord SDK, loaded only inside Discord) and
  one more with #139 (Firebase). Everything else is a build or test tool that is not part of the deployed files. Where the
  platform does the job there is no dependency: `fetch`, `crypto.subtle` (PKCE), `crypto.randomUUID`, `URLSearchParams`,
  `createImageBitmap`, `requestAnimationFrame`, Canvas 2D.
- **Official first.** The two runtime SDKs are the vendors' own (Discord and Google/Firebase); the tools are the de facto
  standards of the TypeScript ecosystem, each from its own organisation's repository.
- **Pinned by the lockfile.** `package-lock.json` is committed and every workflow installs with `npm ci`, so what is
  built is what was reviewed. The `^` ranges of `package.json` only matter on a manual `npm install`.
- **Audited on every PR.** `ci-frontend.yml` job `audit` runs `npm audit --omit=dev --audit-level=high`. A finding may
  only be passed with a justified, dated entry in `app/frontend/audit-exceptions.json` ([`ci/dependency-audit.md`](ci/dependency-audit.md)).
- **Licences.** MIT or Apache-2.0 (one `Unlicense`, public domain, in a transitive package): all compatible with a
  public repository.
- **Known gap: no update bot.** There is no Dependabot or Renovate configuration in the repository; versions are raised
  by hand. The table gives the latest version so that the distance is visible.

## Runtime dependencies (`dependencies`)

| Package | Version | Licence | Last release of this version | Used for | Why it is safe and maintained |
| --- | --- | --- | --- | --- | --- |
| `@discord/embedded-app-sdk` | 2.5.0 | MIT | 2026-05-05 (a 3.0 beta line has been published since October 2026) | Discord Activity: `DiscordSDK` handshake (`ready`, `authorize`, `authenticate`) and `patchUrlMappings`, in `src/auth/activity.ts`. Loaded by dynamic `import()` only when the page runs in an Activity (separate 47 kB gzip chunk) | **Official** SDK published by Discord (github.com/discord/embedded-app-sdk), the only supported way to run an Activity. Sole consumer of its 7 transitive packages (table below). Its Zod dependency triggers an advisory, handled by a justified exception (next section) |
| `firebase` **(#139)** | 13.4.0 (`^13.4.0`) | Apache-2.0 | 2026-11-16 | `firebase/app`, `firebase/auth` (`signInWithCustomToken`), `firebase/firestore` (`onSnapshot` read-only listeners), in `src/backend/gcp/`. Loaded after login as its own chunk (about 167 kB gzip according to the #139 build) | **Official** Google SDK (github.com/firebase/firebase-js-sdk), released several times a month. Only the modular imports above are bundled (tree shaking). The 278-package lockfile of #139 (166 today) comes from it. Uses the user's custom token: no service account key in the browser |
| `@grpc/grpc-js` **(#139)**, transitive of `firebase`, `overrides` to `^1.14.7` (lock: 1.14.7) | 1.14.7 | Apache-2.0 | grpc project (github.com/grpc/grpc-node) | Used by the Node build of the Firestore SDK only. **Not in the browser bundle** (checked on the #139 build); forced to `^1.14.7` because the 1.9 line the SDK pulled has a high severity advisory that `npm audit` reports | Official gRPC project (CNCF). The override is the fix, not an exception: no audit exception was added |

### Transitive dependencies of the Discord SDK (lockfile, production)

| Package | Version | Licence | Last published | Note |
| --- | --- | --- | --- | --- |
| `zod` | 3.25.76 | MIT | 2026-10-12 | Schema validation inside the SDK. Advisory **GHSA-mrhx-c7xc-m3w5** (memory exhaustion in the **v4** array parser) is reported by `npm audit` on it. **Exception justified** in `audit-exceptions.json`: the SDK pins `zod ^3.9.8`, imports the v3 API and never loads `zod/v4`; the production bundle contains none of the v4 code (0 occurrences of `handleArrayResult`, `$ZodArray`). The patched range (>= 4.6.6) is a major upgrade the SDK does not support. Expires **2026-12-31**, to review with the SDK 3.x line |
| `uuid` | 11.1.1 | MIT | 2026-10-10 | Ids in RPC messages |
| `eventemitter3` | 5.0.4 | MIT | 2026-01-19 | Event emitter |
| `big-integer` | 1.6.52 | Unlicense | 2024-02-16 | 64-bit flag arithmetic (`BigFlagUtils`, Discord permissions). Stable, no open advisory, small and finished library |
| `decimal.js-light` | 2.5.1 | MIT | 2022-06-14 | Decimal arithmetic of the SDK's price helpers (`PriceUtils`). Old but a finished library with no dependency |
| `lodash.transform` | 4.6.0 | MIT | 2022-06-19 | Single-function lodash module (object transformation in the SDK). Old but frozen |
| `@types/uuid`, `@types/lodash.transform` (and `@types/lodash`) | 10.0.0, 4.6.9 (4.17.27) | MIT | DefinitelyTyped | Types only, nothing in the bundle |

All of them are covered by the `npm audit` of every PR; the only finding is the Zod one above.

## Build, lint and test tools (`devDependencies`)

None of these is part of the deployed files: they run on a developer machine or a CI runner.

| Package | Version | Licence | Last release of this version | Latest at check time | Used for | Why it is safe and maintained |
| --- | --- | --- | --- | --- | --- | --- |
| `vite` | 8.3.5 | MIT | 2026-10-21 | 8.4.0 | Dev server and production build (`vite build`): hashed assets, tree shaking of the mock through the `__BACKEND__` constant, code splitting | The standard front-end build tool (vitejs organisation), several releases a month |
| `typescript` | 6.0.3 | Apache-2.0 | 2026-04-16 | 7.0.2 | Type checking (`tsc --noEmit`, part of `npm run build`) | Microsoft. One major version behind (7.0 is published): a later upgrade, not a blocker, to do together with `typescript-eslint` |
| `vitest` | 5.0.5 | MIT | 2026-10-15 | 5.1.2 | Unit tests (`npm test`, Node environment, 84 tests today) | Vite's own test runner (vitest-dev), active releases |
| `eslint` | 10.13.0 | MIT | 2026-10-16 | 10.15.0 | Lint (`npm run lint`); the rule that forbids `setInterval` (no polling) is enforced here | OpenJS Foundation project, the reference JavaScript linter |
| `@eslint/js` | 10.0.1 | MIT | 2026-02-06 | 10.0.1 | ESLint's recommended rule set | Same project; at its latest version |
| `typescript-eslint` | 8.72.0 | MIT | 2026-10-19 | 8.74.0 | TypeScript parser and rules for ESLint | The official TypeScript tooling for ESLint (typescript-eslint organisation), pre-releases almost daily, stable releases every week or two |
| `globals` | 17.13.0 | MIT | 2026-10-01 | 17.14.0 | Browser global names for ESLint (`globals.browser`) | Maintained by Sindre Sorhus, a widely used list of global names |
| `@types/node` | 26.6.5 | MIT | 2026-10-09 | 26.6.11 | Types for the Node APIs seen by the config files | DefinitelyTyped, the official type source for Node |

No package of the lockfile is deprecated at the versions in use (`npm view <package>@<version> deprecated` is empty for
every direct dependency).

## GitHub Actions used for the front

Referenced by **major tag**, like every workflow of the repository; the repository-wide decision to pin by commit SHA is
discussed in the infra track page `infra-security.md` (#80, "Known trade-offs"). All are published by GitHub, HashiCorp or
Google; none receives a secret in the front jobs.

| Action | Version | Workflow | Used for | Why it is safe |
| --- | --- | --- | --- | --- |
| `actions/checkout` | v4 | `ci-frontend`, `deploy` | Checkout | Official GitHub action |
| `actions/setup-node` | v4 | `ci-frontend`, `deploy` | Node 22 and the npm cache (keyed on the lockfile) | Official GitHub action |
| `actions/upload-artifact` | v4 | `deploy` | Publishes the **single** build (`app-<sha>`: functions zip and `frontend/`) | Official GitHub action |
| `actions/download-artifact` | v4 | `deploy-env` | Downloads that same artefact for `dev`, then for `prd` | Official GitHub action |
| `hashicorp/setup-terraform` | v3 | `deploy-env` | Terraform that uploads the build and `config.json` to the bucket | Official HashiCorp action |
| `google-github-actions/auth` | v2 | `deploy-env` | Workload Identity Federation (no key), 1 h token | Official Google action |
| `dorny/paths-filter` | v3 | `ci-gate` | Tells whether `app/frontend/**` changed so that `ci-frontend` is required | The one community action of the repository, justified in `open-source-infra.md` (#80): read-only on the changed file list |

`ci-frontend.yml` runs with `permissions: contents: read`; the job `audit` needs no secret. The tools of
`ci-security.yml` (gitleaks 8.21.2, semgrep) that also scan the front are listed in `open-source-infra.md` (#80).

## Terraform for the front hosting

No third-party module, no extra provider: `infra/serverless/frontend.tf` only uses resources of `hashicorp/google`
(`~> 7.0`, official, listed with the infra track): a private bucket and its objects, a backend bucket with Cloud CDN,
a managed certificate, an SSL policy, URL maps, a target proxy and forwarding rules. See "Frontend hosting" in
[`infra/serverless/README.md`](../infra/serverless/README.md).

## External services the browser calls

| Service | Called from | What is sent | Authentication |
| --- | --- | --- | --- |
| Discord (`discord.com/oauth2/authorize`, and in an Activity the Discord client and its proxy `<app_id>.discordsays.com`) | the login, every Activity request | `client_id`, `state`, PKCE challenge, scope `identify` | none from our side (public client id); the code is exchanged by our function |
| API Gateway (`*.gateway.dev`) | every request | `Authorization: Bearer <JWT>`, `X-Correlation-Id` | our session JWT, checked by the gateway |
| Firestore, Identity Toolkit, Token Service (`*.googleapis.com`) **(#139)** | real-time listeners and Firebase sign-in | the user's Firebase token | custom token minted by `auth-discord`; Firestore rules decide the rest |
| Cloud CDN / the load balancer of the app | page, assets, `config.json`, tiles | nothing but the request | none (public static files) |
| `sslip.io` (DNS only) | the hostname of the app | nothing: it resolves a name to the IP written in it | none; trade-off in `open-source-infra.md` (#80) |

No analytics, no tracker, no third-party font or script is loaded: the page only fetches files from its own origin and the
services above.
