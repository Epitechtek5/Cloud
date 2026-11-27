# Security summary of the front track

Subject 5.3 (least privilege, secrets, what is public) and 5.6, issue #82. The identities of the pipeline, the runners and
the secrets inventory are in the infra track page (`infra-security.md`, #80, not merged yet); the identity of every function
is in [`functions.md`](functions.md). This page covers what the browser holds, what it can reach, and what is deliberately
public.

## What the browser holds

| Item | Where it lives | Lifetime | Secret? |
| --- | --- | --- | --- |
| Session JWT (our own, `sub` = Discord id) | JavaScript memory only | 10 minutes (`auth_jwt_ttl_seconds`, default 600) | yes, but short and never written to disk |
| Firebase custom token and Firebase ID token (#139) | memory (Firebase SDK) | custom token up to the JWT lifetime; the SDK refreshes the ID token | yes, same handling |
| OAuth `state`, PKCE verifier | `sessionStorage` during the Discord redirect only | removed on return, also on `?error=` | single-use values, useless without the code |
| Discord access token | not stored: in an Activity it is handed to `sdk.authenticate()` and dropped; the web flow never receives it | none | yes, never persisted |
| `/config.json` | fetched with `cache: 'no-store'` | per page load | no, see below |

No token is ever written to `localStorage`, a cookie or the URL. The only place a token is sent is the `Authorization`
header of a request to the gateway (and the Firebase SDK's own sign-in).

## What is public, and why

Everything the front needs to *run* is public by nature: it is in the bundle, in `/config.json`, or in the network tab.
The security of the project never depends on hiding one of them.

| Public value | Where | Why it is safe |
| --- | --- | --- |
| Discord application id (`client_id`), one per environment | `/config.json`, every authorize URL | An OAuth client id identifies the application, it is not a credential. Using it needs the **client secret** (Secret Manager, read only by `auth-discord`) and a redirect URI that is **registered** in the Developer Portal and in the function's allow-list `auth_discord_redirect_uris` |
| Firebase web API key | `/config.json` (`firebase.apiKey`) | Google's own documentation: for Firebase web apps the key is an identifier of the project, not a secret. It grants nothing by itself: what a signed-in client may do is decided by the **Firestore security rules** (read only, own documents, `limit <= 65536`, only a *custom token* sign-in provider accepted), and signing in needs a custom token that only `auth-discord` can mint. The key can additionally be restricted (see below) |
| `projectId`, `authDomain`, `apiBase` | `/config.json` | Names and URLs. The gateway rejects calls without a valid JWT, Firestore rejects anything the rules do not allow |
| Tile rasters (`/tiles/*`, #68) | CDN, no `Authorization` | A raster is the public picture of the canvas; there is nothing in it that the live canvas does not show. The bucket behind it is still private (served by a function through the load balancer, or signed URLs: question A) |
| The bundle and its source maps | CDN | The repository is public. Source maps are published on purpose, they leak nothing the repo does not show |
| The load balancer IP and `<ip>.sslip.io` host | DNS, certificate transparency logs | It is the address of a web server |

**Restricting the Firebase key (recommended, to do in the console or Terraform):** limit the key to the APIs the front
uses (Identity Toolkit and Token Service for the sign-in, Cloud Firestore) and to the HTTP referrers of the app
(`https://<ip>.sslip.io/*`, `https://<client_id>.discordsays.com/*`, `http://localhost:5173/*`). A restriction by referrer is
a guard against reuse of the key from another site, not an authentication. This restriction is not managed by the
repository today, and nothing could verify it from here: it is listed as a trade-off below.

## What is not public

| Secret | Where it lives | Who can read it | Reaches the browser? |
| --- | --- | --- | --- |
| Discord OAuth2 client secret | Secret Manager (`discord-oauth-client-secret`) | `auth-discord` service account only | never |
| Discord bot token, interaction public key | Secret Manager | the deploy account reads the bot token (registers the commands), `discord-proxy` reads the public key | never |
| JWT signing key | none: the JWT is signed by the function's service account through IAM Credentials (`signJwt`) | nobody holds a key | only the public keys (JWKS), served by Google, are used by the gateway |
| Firebase admin access, Firestore write access | IAM of the worker service accounts | the workers only | never: the rules refuse every client write |
| Cloud Storage buckets | private (`public_access_prevention = enforced`) | the load balancer agent for the front bucket, workers for rasters | no direct URL: files come through the CDN or the gateway |

Details of every role: [`functions.md`](functions.md) and the infra track page `infra-security.md` (#80).

## Controls in the front itself

- **Login (CSRF and code injection).** The web flow generates a random `state` and a PKCE (S256) challenge; a callback whose
  `state` does not match the stored one is rejected **before any network call**. `state` and verifier are single-use.
  Tests: `src/auth/web.test.ts`, `pkce.test.ts`.
- **Least scope.** Only `identify` is requested.
- **No injection through user data.** The pixel inspector writes the author name (chosen by the user on Discord) with
  `escapeHtml`; every other interpolated value is a number. No `eval`, no `document.write`.
- **Never trust the answer shape.** `exchange.ts`, the gateway client and the tile source (#139) validate the type of every
  field they read and refuse a non-PNG tile or a missing `X-Tile-Version` rather than display a wrong state.
- **Input checked twice.** The front refuses coordinates outside the grid and batches above 256 pixels before sending;
  the proxy and the worker validate again, because a modified client would skip the first check.
- **Read-only real time.** The front only builds queries that the Firestore rules accept; a write attempt is refused by the
  rules, and the rules are tested in the emulator (`ci-firestore-rules`).
- **Activity sandbox.** Network calls leave the iframe only through the Discord proxy, to the hosts declared in the URL
  mappings; `fetch` is looked up at call time (`lateFetch`) so the proxy cannot be bypassed by a stale reference.
- **Supply chain.** Lockfile with `npm ci`, `npm audit` blocking on high and critical (with dated, justified exceptions
  only), gitleaks and semgrep on every PR; see [`open-source-frontend.md`](open-source-frontend.md).

## Controls on the path to the browser (hosting)

Set by Terraform in `infra/serverless/frontend.tf` (see the "Frontend hosting" section of
[`infra/serverless/README.md`](../infra/serverless/README.md)): HTTPS only (port 80 answers `301`), Google-managed
certificate, TLS 1.2 minimum (`MODERN` policy), `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, a bucket with public access prevention enforced and a single reader (the
load balancer service agent, `objectViewer` on that bucket only), and no function reachable except through the API
Gateway or the load balancer.

## Known trade-offs

| Trade-off | Why it is accepted | Mitigation or next step |
| --- | --- | --- |
| No `Content-Security-Policy` header | The Activity iframe and the Firebase SDK need a tested list of origins; a wrong policy would break the Activity | The code has no inline script and no `eval` (one inline `style` attribute in the pixel inspector would need `style-src 'unsafe-inline'` or a class). Minimal safe policy to add after a test in a real Activity: `frame-ancestors 'self' https://discord.com https://*.discord.com https://*.discordsays.com; object-src 'none'; base-uri 'self'` |
| No `X-Frame-Options` / restrictive `frame-ancestors` | The Discord Activity runs the page in an iframe | Covered by the CSP item above |
| The Firebase key is not restricted by the repository | The Firebase web app is created in the console (not Terraform) | See the paragraph above; the rules are the real barrier |
| Tiles are public (no `Authorization`) | Cached by the CDN for everybody, same content as the canvas | To confirm with #68 |
| A reload is a logout in the browser | The token is in memory only | One click on "Login with Discord" (Discord remembers the consent) |
| The Zod advisory GHSA-mrhx-c7xc-m3w5 is excepted in the audit | Code path unreachable (Zod v4 array parser, not loaded by the Discord SDK which uses Zod 3); no patched version the SDK supports | `audit-exceptions.json`, expires 2026-12-31, retest with the SDK 3.x line |
| `sslip.io` stands in for a domain | No domain bought | Risks and exit in [`reproducibility.md`](reproducibility.md) and the infra track page |
| Firestore inside the Discord iframe is not tested | Needs a real Activity | `experimentalAutoDetectLongPolling` (#139) and plan B behind `RealtimeChannel` (question E) |
