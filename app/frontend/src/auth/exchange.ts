import { AuthError, type Session } from './types';

export interface ExchangeRequest {
  code: string;
  /** Web flow only: must equal the redirect_uri used at the authorize step. */
  redirectUri?: string;
  /** PKCE verifier matching the challenge sent at the authorize step. */
  codeVerifier: string;
  /** Activity flow: the gateway also returns the Discord access token for sdk.authenticate(). */
  activity?: boolean;
}

export interface ExchangeResult {
  session: Session;
  /** Only present for the Activity flow. Never persisted, only handed to the SDK. */
  discordAccessToken?: string;
}

type Fetch = typeof fetch;

/**
 * POST {apiBase}/auth/discord. The gateway function holds the Discord client secret, exchanges
 * the code, reads the user with the `identify` scope and answers with our own short-lived token.
 * Expected body: { token, expiresIn (s), user: { id, username }, discordAccessToken? }.
 */
export async function exchangeCode(fetchFn: Fetch, apiBase: string, req: ExchangeRequest, now = Date.now()): Promise<ExchangeResult> {
  let res: Response;
  try {
    res = await fetchFn(`${apiBase}/auth/discord`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': crypto.randomUUID() },
      body: JSON.stringify(req),
    });
  } catch {
    throw new AuthError('Could not reach the login service.', 'exchange_failed');
  }
  if (!res.ok) throw new AuthError(`Login failed (HTTP ${res.status}).`, 'exchange_failed');

  const b = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const user = b?.user as Record<string, unknown> | undefined;
  if (
    !b ||
    typeof b.token !== 'string' ||
    typeof b.expiresIn !== 'number' ||
    typeof user?.id !== 'string' ||
    typeof user.username !== 'string' ||
    (b.discordAccessToken !== undefined && typeof b.discordAccessToken !== 'string')
  ) {
    throw new AuthError('Unexpected response from the login service.', 'exchange_failed');
  }
  return {
    session: { token: b.token, expiresAt: now + b.expiresIn * 1000, user: { id: user.id, username: user.username } },
    discordAccessToken: b.discordAccessToken as string | undefined,
  };
}
