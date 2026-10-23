import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { loadRuntimeConfig, parseRuntimeConfig } from './runtimeConfig';

const valid = { env: 'dev', apiBase: 'https://api.example', firebase: { apiKey: 'k', projectId: 'p', authDomain: 'a' } };

describe('parseRuntimeConfig', () => {
  it('accepts a complete config', () => {
    expect(parseRuntimeConfig(valid)).toEqual(valid);
  });
  it.each([null, {}, { ...valid, apiBase: 1 }, { ...valid, firebase: { apiKey: 'k' } }])('rejects %j', (bad) => {
    expect(() => parseRuntimeConfig(bad)).toThrow(/Invalid \/config.json/);
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
