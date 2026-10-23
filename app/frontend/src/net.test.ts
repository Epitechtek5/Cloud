import { afterEach, describe, expect, it, vi } from 'vitest';
import { lateFetch } from './net';

afterEach(() => vi.unstubAllGlobals());

describe('lateFetch', () => {
  it('uses the fetch installed AFTER the reference was taken (patched fetch)', async () => {
    const original = vi.fn(async () => new Response('original'));
    vi.stubGlobal('fetch', original);
    const ref = lateFetch; // taken before patching, like createAuth does at startup
    const patched = vi.fn(async () => new Response('patched'));
    vi.stubGlobal('fetch', patched); // what patchUrlMappings does to window.fetch
    expect(await (await ref('https://gw/x')).text()).toBe('patched');
    expect(original).not.toHaveBeenCalled();
    expect(patched).toHaveBeenCalledWith('https://gw/x');
  });
});
