import type { UrlMapping } from '../platform/context';
import { exchangeCode } from './exchange';
import { challengeS256, randomString } from './pkce';
import { AuthError, isFresh, type AuthProvider, type Session } from './types';

/** The subset of @discord/embedded-app-sdk we use (injectable for tests). */
export interface ActivitySdk {
  ready(): Promise<void>;
  commands: {
    authorize(args: {
      client_id: string;
      response_type: 'code';
      state: string;
      prompt: 'none';
      scope: 'identify'[];
      code_challenge: string;
      code_challenge_method: 'S256';
    }): Promise<{ code: string }>;
    authenticate(args: { access_token: string }): Promise<unknown>;
  };
}

export interface SdkLoader {
  (clientId: string): Promise<{ sdk: ActivitySdk; patchUrlMappings(m: UrlMapping[]): void }>;
}

/** Loaded on demand: the SDK is only needed inside Discord. */
export const loadDiscordSdk: SdkLoader = async (clientId) => {
  const m = await import('@discord/embedded-app-sdk');
  return { sdk: new m.DiscordSDK(clientId) as unknown as ActivitySdk, patchUrlMappings: m.patchUrlMappings };
};

export interface ActivityAuthDeps {
  clientId: string;
  apiBase: string;
  mappings: UrlMapping[];
  fetch: typeof fetch;
  loadSdk?: SdkLoader;
}

/**
 * Discord Activity flow: sdk.ready -> authorize (code) -> gateway exchange -> sdk.authenticate.
 * No redirect, no consent screen beyond Discord's own modal; the token lives in memory.
 */
export class ActivityAuth implements AuthProvider {
  session: Session | null = null;
  private sdk: ActivitySdk | null = null;
  private pending: Promise<Session> | null = null;

  constructor(private d: ActivityAuthDeps) {}

  async restore(): Promise<Session | null> {
    return this.handshake();
  }

  /** In an Activity there is no separate login step: the handshake is the login. */
  async login(): Promise<void> {
    await this.handshake();
  }

  async token(): Promise<string> {
    const s = isFresh(this.session) ? this.session : await this.handshake();
    return s.token;
  }

  logout(): void {
    this.session = null;
  }

  private handshake(): Promise<Session> {
    // Concurrent callers (several API calls at expiry) share one handshake.
    this.pending ??= this.run().finally(() => (this.pending = null));
    return this.pending;
  }

  private async run(): Promise<Session> {
    try {
      if (!this.sdk) {
        const { sdk, patchUrlMappings } = await (this.d.loadSdk ?? loadDiscordSdk)(this.d.clientId);
        patchUrlMappings(this.d.mappings); // before any network call, so they go through the proxy
        await sdk.ready();
        this.sdk = sdk;
      }
      const verifier = randomString(48);
      const { code } = await this.sdk.commands.authorize({
        client_id: this.d.clientId,
        response_type: 'code',
        state: '',
        prompt: 'none',
        scope: ['identify'],
        code_challenge: await challengeS256(verifier),
        code_challenge_method: 'S256',
      });
      const { session, discordAccessToken } = await exchangeCode(this.d.fetch, this.d.apiBase, { code, codeVerifier: verifier, activity: true });
      if (!discordAccessToken) throw new AuthError('The login service did not return an Activity token.', 'exchange_failed');
      await this.sdk.commands.authenticate({ access_token: discordAccessToken });
      this.session = session;
      return session;
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw new AuthError(e instanceof Error ? e.message : 'Discord handshake failed.', 'sdk');
    }
  }
}
