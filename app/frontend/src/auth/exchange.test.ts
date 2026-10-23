import { describe, expect, it, vi } from 'vitest';
import { exchangeCode } from './exchange';

const ok = { token: 'jwt', expiresIn: 600, user: { id: '42', username: 'alice' } };
const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('exchangeCode', () => {
  it('posts the code to the gateway and builds a session', async () => {
    const f = reply({ ...ok, discordAccessToken: 'dat' });
    const r = await exchangeCode(f, 'https://gw', { code: 'c', codeVerifier: 'v', activity: true }, 1_000);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gw/auth/discord');
    expect(JSON.parse(init.body as string)).toEqual({ code: 'c', codeVerifier: 'v', activity: true });
    expect((init.headers as Record<string, string>)['X-Correlation-Id']).toBeTruthy();
    expect(r.session).toEqual({ token: 'jwt', expiresAt: 1_000 + 600_000, user: { id: '42', username: 'alice' } });
    expect(r.discordAccessToken).toBe('dat');
  });

  it('fails on HTTP errors, network errors and malformed bodies', async () => {
    await expect(exchangeCode(reply({}, 401), 'https://gw', { code: 'c', codeVerifier: 'v' })).rejects.toThrow(/HTTP 401/);
    await expect(exchangeCode(vi.fn(async () => Promise.reject(new Error('x'))), 'https://gw', { code: 'c', codeVerifier: 'v' })).rejects.toThrow(/Could not reach/);
    await expect(exchangeCode(reply({ token: 'x' }), 'https://gw', { code: 'c', codeVerifier: 'v' })).rejects.toThrow(/Unexpected response/);
    await expect(exchangeCode(reply({ ...ok, expiresIn: '600' }), 'https://gw', { code: 'c', codeVerifier: 'v' })).rejects.toThrow(/Unexpected response/);
  });
});
