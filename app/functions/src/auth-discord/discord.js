// Calls to Discord: authorization code exchange (RFC 6749 §4.1.3, with PKCE
// RFC 7636) and the current user (scope `identify`). The access token is only
// returned to the caller, never stored, and no error carries a response body.

export const DISCORD_API = "https://discord.com/api/v10";

/** Error with a safe, fixed `reason` and the upstream HTTP status, nothing else. */
export class DiscordError extends Error {
  constructor(reason, status) {
    super(reason);
    this.name = "DiscordError";
    this.reason = reason;
    this.status = status;
  }
}

async function call(fetchFn, url, init, step, timeoutMs) {
  let res;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new DiscordError(`${step}_unreachable`, 0);
  }
  if (!res.ok) {
    // 400/401 on the token step: bad, expired or reused code, wrong verifier
    // or redirect_uri. Everything else is Discord's side (5xx, 429).
    const rejected = step === "token" && (res.status === 400 || res.status === 401);
    throw new DiscordError(rejected ? "invalid_grant" : `${step}_http_error`, res.status);
  }
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== "object") throw new DiscordError(`${step}_bad_response`, res.status);
  return body;
}

/**
 * @returns {Promise<string>} the Discord access token (scope checked)
 */
export async function exchangeCode(fetchFn, { timeoutMs, clientId, clientSecret, code, codeVerifier, redirectUri }) {
  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
  });
  // Web flow only: must be the redirect_uri of the authorize step. The
  // Activity flow (sdk.commands.authorize) has none.
  if (redirectUri !== undefined) form.set("redirect_uri", redirectUri);

  const body = await call(
    fetchFn,
    `${DISCORD_API}/oauth2/token`,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form },
    "token",
    timeoutMs,
  );
  // body.refresh_token is deliberately ignored: it is dropped with `body`.
  if (typeof body.access_token !== "string" || String(body.token_type).toLowerCase() !== "bearer") {
    throw new DiscordError("token_bad_response", 200);
  }
  const scopes = typeof body.scope === "string" ? body.scope.split(" ") : [];
  if (!scopes.includes("identify")) throw new DiscordError("token_missing_identify_scope", 200);
  return body.access_token;
}

/** @returns {Promise<{id: string, username: string}>} */
export async function fetchUser(fetchFn, { timeoutMs, accessToken }) {
  const body = await call(
    fetchFn,
    `${DISCORD_API}/users/@me`,
    { method: "GET", headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
    "user",
    timeoutMs,
  );
  if (typeof body.id !== "string" || !/^\d{1,20}$/.test(body.id) || typeof body.username !== "string") {
    throw new DiscordError("user_bad_response", 200);
  }
  return { id: body.id, username: body.username };
}
