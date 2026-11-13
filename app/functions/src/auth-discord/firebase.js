// Optional Firebase custom token (uid = Discord id), used by the front for
// signInWithCustomToken() before opening its Firestore listeners. Enabled by
// FIREBASE_CUSTOM_TOKEN=true only.
//
// No service account key: the function's own account signs the token through
// the IAM Credentials API (signJwt), which needs
// roles/iam.serviceAccountTokenCreator on that account itself (granted in
// infra/serverless/auth_discord.tf, never at project level). This is what the
// Admin SDK does too when it runs without a key file.

export class FirebaseTokenError extends Error {
  constructor(reason, status = 0) {
    super(reason);
    this.name = "FirebaseTokenError";
    this.reason = reason;
    this.status = status;
  }
}

async function request(fetchFn, url, init, reason, timeoutMs) {
  let res;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new FirebaseTokenError(`${reason}_unreachable`);
  }
  if (!res.ok) throw new FirebaseTokenError(`${reason}_http_error`, res.status);
  return res;
}

/** Signer bound to one instance: caches the account email and its access token. */
export function createFirebaseSigner(fetchFn, { metadataUrl, iamCredentialsUrl, audience, timeoutMs }, now = () => Date.now()) {
  let email;
  let cached = { token: "", expiresAt: 0 };
  const metadata = { headers: { "Metadata-Flavor": "Google" } };

  async function accessToken() {
    if (cached.expiresAt - 60_000 > now()) return cached.token;
    const res = await request(fetchFn, `${metadataUrl}/token`, metadata, "metadata_token", timeoutMs);
    const body = await res.json().catch(() => null);
    if (typeof body?.access_token !== "string") throw new FirebaseTokenError("metadata_token_bad_response", res.status);
    cached ={ token: body.access_token, expiresAt: now() + body.expires_in * 1000 };
    return cached.token;
  }

  return async function customToken(uid, ttlSeconds) {
    email ??= (await (await request(fetchFn, `${metadataUrl}/email`, metadata, "metadata_email", timeoutMs)).text()).trim();
    const iat = Math.floor(now() / 1000);
    // Firebase accepts at most one hour; the front exchanges it right away.
    const claims = { iss: email, sub: email, aud: audience, iat, exp: iat + Math.min(ttlSeconds, 3600), uid };
    const res = await request(
      fetchFn,
      `${iamCredentialsUrl}/projects/-/serviceAccounts/${encodeURIComponent(email)}:signJwt`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ payload: JSON.stringify(claims) }),
      },
      "sign_jwt",
      timeoutMs,
    );
    const body = await res.json().catch(() => null);
    if (typeof body?.signedJwt !== "string") throw new FirebaseTokenError("sign_jwt_bad_response", res.status);
    return body.signedJwt;
  };
}
