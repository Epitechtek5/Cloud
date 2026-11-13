// Signs a JWT with the function's own service account, through the IAM
// Credentials API (signJwt). There is no key to store, rotate or leak: Google
// holds the private key and publishes the public one at
//   https://www.googleapis.com/robot/v1/metadata/x509/<service account email>
// which is what the API Gateway uses to verify our session tokens
// (x-google-jwks_uri in infra/serverless/openapi/api.yaml.tftpl) and what
// Firebase uses for its custom tokens.
//
// Needs roles/iam.serviceAccountTokenCreator on the function's own account,
// granted on that account only in infra/serverless/auth_discord.tf (never at
// project level, where it would allow impersonating every account).

const METADATA = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default";
const IAM_CREDENTIALS = "https://iamcredentials.googleapis.com/v1";

export class SigningError extends Error {
  constructor(reason, status = 0) {
    super(reason);
    this.name = "SigningError";
    this.reason = reason; // logged, never returned to the client
    this.status = status;
  }
}

async function request(fetchFn, url, init, reason, timeoutMs) {
  let res;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new SigningError(`${reason}_unreachable`);
  }
  if (!res.ok) throw new SigningError(`${reason}_http_error`, res.status);
  return res;
}

/**
 * Signer bound to one instance: it caches the account email and the access
 * token used to call IAM Credentials.
 *
 * @param {typeof fetch} fetchFn
 * @param {number} timeoutMs timeout of each outgoing call
 * @param {() => number} [now] epoch ms
 * @returns {{ email: () => Promise<string>, sign: (claims: object) => Promise<string> }}
 */
export function createIamSigner(fetchFn, timeoutMs, now = () => Date.now()) {
  let emailValue;
  let cached = { token: "", expiresAt: 0 };
  const metadata = { headers: { "Metadata-Flavor": "Google" } };

  async function email() {
    emailValue ??= (await (await request(fetchFn, `${METADATA}/email`, metadata, "metadata_email", timeoutMs)).text()).trim();
    return emailValue;
  }

  async function accessToken() {
    if (cached.expiresAt - 60_000 > now()) return cached.token;
    const res = await request(fetchFn, `${METADATA}/token`, metadata, "metadata_token", timeoutMs);
    const body = await res.json().catch(() => null);
    if (typeof body?.access_token !== "string") throw new SigningError("metadata_token_bad_response", res.status);
    cached = { token: body.access_token, expiresAt: now() + body.expires_in * 1000 };
    return cached.token;
  }

  async function sign(claims) {
    const account = await email();
    const res = await request(
      fetchFn,
      `${IAM_CREDENTIALS}/projects/-/serviceAccounts/${encodeURIComponent(account)}:signJwt`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ payload: JSON.stringify(claims) }),
      },
      "sign_jwt",
      timeoutMs,
    );
    const body = await res.json().catch(() => null);
    if (typeof body?.signedJwt !== "string") throw new SigningError("sign_jwt_bad_response", res.status);
    return body.signedJwt;
  }

  return { email, sign };
}
