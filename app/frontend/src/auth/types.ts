export interface DiscordUser {
  id: string;
  username: string;
}

/** Our own short-lived token (issued by the gateway after the Discord code exchange). */
export interface Session {
  user: DiscordUser;
  token: string;
  /** epoch ms */
  expiresAt: number;
}

export class AuthError extends Error {
  constructor(message: string, readonly kind: 'login_required' | 'exchange_failed' | 'state_mismatch' | 'sdk') {
    super(message);
    this.name = 'AuthError';
  }
}

export interface AuthProvider {
  /** Completes a pending login (OAuth redirect / Activity handshake) or returns null when logged out. */
  restore(): Promise<Session | null>;
  /** Starts an interactive login (web: redirects to Discord). */
  login(): Promise<void>;
  /** Bearer token for the gateway; refreshes or throws `login_required` when expired. */
  token(): Promise<string>;
  logout(): void;
  readonly session: Session | null;
}

/** Refresh slightly before the real expiry to avoid sending an expired token. */
export const EXPIRY_MARGIN_MS = 30_000;
export const isFresh = (s: Session | null, now = Date.now()): s is Session => !!s && s.expiresAt - EXPIRY_MARGIN_MS > now;
