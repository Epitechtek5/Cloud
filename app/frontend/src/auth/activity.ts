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
  /** How long to wait for Discord's handshake before giving up. */
  readyTimeoutMs?: number;
}

const READY_TIMEOUT_MS = 15_000;
const NOT_IN_DISCORD = 'Discord did not answer. Open this app from a voice channel in Discord (Activities).';

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AuthError(message, 'sdk')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Discord Activity flow: sdk.ready -> authorize (code) -> gateway exchange -> sdk.authenticate.
 * No redirect, no consent screen beyond Discord's own modal; the token lives in memory.
 */
export class ActivityAuth implements AuthProvider {
  session: Session | null = null;
  // Cached separately: a failed ready() must be retryable WITHOUT loading a second SDK and
  // patching fetch/XHR/WebSocket again (the proxies would stack and listeners be duplicated).
  private booted: Promise<ActivitySdk> | null = null;
  private ready: Promise<void> | null = null;
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

  /** Loads the SDK and installs the URL mappings exactly once (before any network call). */
  private boot(): Promise<ActivitySdk> {
    this.booted ??= (async () => {
      const { sdk, patchUrlMappings } = await (this.d.loadSdk ?? loadDiscordSdk)(this.d.clientId);
      patchUrlMappings(this.d.mappings);
      return sdk;
    })().catch((e) => {
      this.booted = null; // nothing was patched yet: a retry may load again
      throw e;
    });
    return this.booted;
  }

  private async connect(): Promise<ActivitySdk> {
    const sdk = await this.boot();
    this.ready ??= withTimeout(sdk.ready(), this.d.readyTimeoutMs ?? READY_TIMEOUT_MS, NOT_IN_DISCORD).catch((e) => {
      this.ready = null;
      throw e;
    });
    await this.ready;
    return sdk;
  }

  private async run(): Promise<Session> {
    try {
      const sdk = await this.connect();
      const verifier = randomString(48);
      const { code } = await sdk.commands.authorize({
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
      await sdk.commands.authenticate({ access_token: discordAccessToken });
      this.session = session;
      return session;
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw new AuthError(e instanceof Error ? e.message : 'Discord handshake failed.', 'sdk');
    }
  }
}
