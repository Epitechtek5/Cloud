import { exchangeCode } from './exchange';
import { challengeS256, randomString } from './pkce';
import { AuthError, isFresh, type AuthProvider, type Session } from './types';

/** sessionStorage-like. Only the short-lived `state` and PKCE verifier live there, never a token. */
export interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface WebAuthDeps {
  clientId: string;
  apiBase: string;
  fetch: typeof fetch;
  storage: KeyValueStore;
  /** Current page URL (the redirect target; also where the OAuth callback lands). */
  href: string;
  /** Replaces the URL without reloading (strips ?code&state after the callback). */
  replaceUrl(url: string): void;
  redirect(url: string): void;
}

const K_STATE = 'oauth.state';
const K_VERIFIER = 'oauth.verifier';
const AUTHORIZE = 'https://discord.com/oauth2/authorize';

/** Authorization-code + PKCE flow, scope `identify` only. The token is kept in memory. */
export class WebAuth implements AuthProvider {
  session: Session | null = null;

  constructor(private d: WebAuthDeps) {}

  private get redirectUri(): string {
    const u = new URL(this.d.href);
    return u.origin + u.pathname;
  }

  async login(): Promise<void> {
    const state = randomString();
    const verifier = randomString(48);
    this.d.storage.setItem(K_STATE, state);
    this.d.storage.setItem(K_VERIFIER, verifier);
    const q = new URLSearchParams({
      client_id: this.d.clientId,
      response_type: 'code',
      scope: 'identify',
      redirect_uri: this.redirectUri,
      state,
      code_challenge: await challengeS256(verifier),
      code_challenge_method: 'S256',
    });
    this.d.redirect(`${AUTHORIZE}?${q}`);
  }

  async restore(): Promise<Session | null> {
    const url = new URL(this.d.href);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (url.searchParams.has('error')) {
      this.clearCallback(url);
      throw new AuthError('Discord login was cancelled.', 'login_required');
    }
    if (!code) return isFresh(this.session) ? this.session : null;

    const expected = this.d.storage.getItem(K_STATE);
    const verifier = this.d.storage.getItem(K_VERIFIER);
    this.d.storage.removeItem(K_STATE);
    this.d.storage.removeItem(K_VERIFIER);
    this.clearCallback(url);
    // Reject callbacks we did not initiate (CSRF / login injection).
    if (!expected || !state || state !== expected || !verifier) {
      throw new AuthError('Login state mismatch, please try again.', 'state_mismatch');
    }
    const { session } = await exchangeCode(this.d.fetch, this.d.apiBase, { code, redirectUri: this.redirectUri, codeVerifier: verifier });
    this.session = session;
    return session;
  }

  async token(): Promise<string> {
    if (!isFresh(this.session)) throw new AuthError('Session expired, please log in again.', 'login_required');
    return this.session.token;
  }

  logout(): void {
    this.session = null;
  }

  private clearCallback(url: URL): void {
    for (const k of ['code', 'state', 'error', 'error_description']) url.searchParams.delete(k);
    this.d.replaceUrl(url.pathname + (url.search || '') + url.hash);
  }
}
