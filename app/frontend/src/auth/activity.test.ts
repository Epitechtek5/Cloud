import { describe, expect, it, vi } from 'vitest';
import { ActivityAuth, type ActivitySdk } from './activity';

const ok = { token: 'jwt', expiresIn: 600, user: { id: '42', username: 'alice' }, discordAccessToken: 'dat' };

function make(body: unknown = ok) {
  const calls: string[] = [];
  const sdk: ActivitySdk = {
    ready: vi.fn(async () => void calls.push('ready')),
    commands: {
      authorize: vi.fn(async () => (calls.push('authorize'), { code: 'CODE' })),
      authenticate: vi.fn(async () => void calls.push('authenticate')),
    },
  };
  const patch = vi.fn(() => void calls.push('patch'));
  const fetchFn = vi.fn(async () => (calls.push('exchange'), new Response(JSON.stringify(body), { status: 200 })));
  const mappings = [{ prefix: '/api', target: 'gw.example' }];
  const auth = new ActivityAuth({ clientId: 'CID', apiBase: 'https://gw.example', mappings, fetch: fetchFn, loadSdk: async () => ({ sdk, patchUrlMappings: patch }) });
  return { auth, sdk, patch, fetchFn, calls, mappings };
}

describe('ActivityAuth', () => {
  it('patches URL mappings first, then ready -> authorize -> exchange -> authenticate', async () => {
    const { auth, calls, patch, mappings, sdk, fetchFn } = make();
    const s = await auth.restore();
    expect(calls).toEqual(['patch', 'ready', 'authorize', 'exchange', 'authenticate']);
    expect(patch).toHaveBeenCalledWith(mappings);
    expect(s?.user.username).toBe('alice');
    expect(sdk.commands.authenticate).toHaveBeenCalledWith({ access_token: 'dat' });
    const authorizeArgs = (sdk.commands.authorize as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(authorizeArgs).toMatchObject({ client_id: 'CID', scope: ['identify'], prompt: 'none', code_challenge_method: 'S256' });
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ code: 'CODE', activity: true });
    expect(body.codeVerifier).toBeTruthy();
  });

  it('reuses the session while fresh, and shares one handshake between concurrent callers', async () => {
    const { auth, fetchFn } = make();
    const [a, b] = await Promise.all([auth.token(), auth.token()]);
    expect([a, b]).toEqual(['jwt', 'jwt']);
    expect(await auth.token()).toBe('jwt');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('re-runs the handshake (without reloading the SDK) once the token expired', async () => {
    const { auth, fetchFn, patch } = make();
    await auth.token();
    auth.session!.expiresAt = Date.now() - 1;
    await auth.token();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('fails if the gateway does not hand back the Activity token', async () => {
    const { auth } = make({ ...ok, discordAccessToken: undefined });
    await expect(auth.restore()).rejects.toMatchObject({ kind: 'exchange_failed' });
  });

  it('wraps SDK failures', async () => {
    const { auth, sdk } = make();
    (sdk.ready as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('not in discord'));
    await expect(auth.restore()).rejects.toMatchObject({ kind: 'sdk', message: 'not in discord' });
  });
});
