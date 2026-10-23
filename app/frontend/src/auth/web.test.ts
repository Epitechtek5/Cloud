import { describe, expect, it, vi } from 'vitest';
import { WebAuth, type KeyValueStore } from './web';

const memStore = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};
const ok = { token: 'jwt', expiresIn: 600, user: { id: '42', username: 'alice' } };

function make(href: string, storage = memStore()) {
  const fetchFn = vi.fn(async () => new Response(JSON.stringify(ok), { status: 200 }));
  const redirect = vi.fn();
  const replaceUrl = vi.fn();
  const auth = new WebAuth({ clientId: 'CID', apiBase: 'https://gw', fetch: fetchFn, storage, href, replaceUrl, redirect });
  return { auth, fetchFn, redirect, replaceUrl, storage };
}

describe('WebAuth', () => {
  it('login redirects to Discord with identify scope, state and a PKCE challenge', async () => {
    const { auth, redirect, storage } = make('https://app.example/play?x=1');
    await auth.login();
    const url = new URL(redirect.mock.calls[0]![0] as string);
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('CID');
    expect(url.searchParams.get('scope')).toBe('identify');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/play');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(storage.getItem('oauth.state'));
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
  });

  it('restore without a code means logged out', async () => {
    const { auth } = make('https://app.example/');
    expect(await auth.restore()).toBeNull();
  });

  it('completes the callback, cleans the URL and keeps the token in memory only', async () => {
    const storage = memStore();
    storage.setItem('oauth.state', 'S');
    storage.setItem('oauth.verifier', 'V');
    const { auth, fetchFn, replaceUrl } = make('https://app.example/play?code=abc&state=S&keep=1', storage);
    const s = await auth.restore();
    expect(s?.user.username).toBe('alice');
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual({ code: 'abc', redirectUri: 'https://app.example/play', codeVerifier: 'V' });
    expect(replaceUrl).toHaveBeenCalledWith('/play?keep=1');
    expect(storage.data.size).toBe(0); // state + verifier are single-use
    expect(await auth.token()).toBe('jwt');
  });

  it('rejects a callback whose state we did not issue (CSRF)', async () => {
    const storage = memStore();
    storage.setItem('oauth.state', 'GOOD');
    storage.setItem('oauth.verifier', 'V');
    const { auth, fetchFn } = make('https://app.example/?code=abc&state=EVIL', storage);
    await expect(auth.restore()).rejects.toMatchObject({ kind: 'state_mismatch' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a callback when no login was started', async () => {
    const { auth, fetchFn } = make('https://app.example/?code=abc&state=S');
    await expect(auth.restore()).rejects.toMatchObject({ kind: 'state_mismatch' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reports a cancelled login', async () => {
    const { auth } = make('https://app.example/?error=access_denied');
    await expect(auth.restore()).rejects.toMatchObject({ kind: 'login_required' });
  });

  it('token() requires a fresh session', async () => {
    const { auth } = make('https://app.example/');
    await expect(auth.token()).rejects.toMatchObject({ kind: 'login_required' });
    auth.session = { token: 't', expiresAt: Date.now() + 10_000, user: { id: '1', username: 'u' } }; // inside the safety margin
    await expect(auth.token()).rejects.toMatchObject({ kind: 'login_required' });
  });
});
