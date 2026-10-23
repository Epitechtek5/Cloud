import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRuntimeConfig, parseRuntimeConfig } from './runtimeConfig';

const valid = {
  env: 'dev',
  apiBase: 'https://api.example',
  discordClientId: '1562814087900037260',
  firebase: { apiKey: 'k', projectId: 'p', authDomain: 'a' },
};

afterEach(() => vi.unstubAllGlobals());

describe('parseRuntimeConfig', () => {
  it('accepts a complete config', () => {
    expect(parseRuntimeConfig(valid)).toEqual(valid);
  });

  it.each([
    null,
    {},
    { ...valid, apiBase: 1 },
    { ...valid, discordClientId: undefined },
    { ...valid, discordClientId: 'not-a-snowflake' },
    { ...valid, firebase: { apiKey: 'k' } },
  ])('rejects %j', (bad) => {
    expect(() => parseRuntimeConfig(bad)).toThrow(/Invalid \/config.json/);
  });

  it('takes the Discord client id from the config (one application per environment)', () => {
    expect(parseRuntimeConfig({ ...valid, discordClientId: '42' }).discordClientId).toBe('42');
  });

  it.each([
    ['https://gw.example/', 'https://gw.example'],
    ['https://gw.example/v1/', 'https://gw.example/v1'],
    ['https://gw.example/v1', 'https://gw.example/v1'],
    ['/api/', '/api'],
  ])('normalizes apiBase %s -> %s (no "//auth/discord")', (input, expected) => {
    expect(parseRuntimeConfig({ ...valid, apiBase: input }).apiBase).toBe(expected);
  });

  it.each(['ftp://gw.example', 'not a url', 'https://gw.example/?x=1', '//evil.example'])('rejects apiBase %s', (apiBase) => {
    expect(() => parseRuntimeConfig({ ...valid, apiBase })).toThrow(/apiBase/);
  });
});

describe('loadRuntimeConfig', () => {
  it('loads and validates the file', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(valid)));
    vi.stubGlobal('fetch', f);
    expect(await loadRuntimeConfig('/config.json')).toEqual(valid);
    expect(f).toHaveBeenCalledWith('/config.json', { cache: 'no-store' });
  });
  it('explains a missing file answered with an HTML fallback page', async () => {
    vi.stubGlobal('fetch', async () => new Response('<!doctype html><html></html>'));
    await expect(loadRuntimeConfig()).rejects.toThrow(/not JSON/);
  });
  it('reports HTTP errors', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }));
    await expect(loadRuntimeConfig()).rejects.toThrow(/HTTP 404/);
  });
});
