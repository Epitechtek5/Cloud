import { describe, expect, it, vi } from 'vitest';
import { TILE_SIZE } from '../../contract';
import { createTileSource } from './tiles';

const rgba = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4).fill(7);
const png = (headers: Record<string, string> = {}) =>
  new Response(new Blob(['png']), { headers: { 'Content-Type': 'image/png', 'X-Tile-Version': '1700000000123', ...headers } });
const mk = (res: Response) => {
  const f = vi.fn(async () => res);
  const decode = vi.fn(async () => rgba);
  return { f, decode, source: createTileSource({ base: '/tiles', fetch: f as unknown as typeof fetch, decode }) };
};
const signal = new AbortController().signal;

describe('loadTile', () => {
  it('returns the decoded raster and its version', async () => {
    const { f, decode, source } = mk(png());
    expect(await source.loadTile(3, 4, signal)).toEqual({ rgba, version: 1_700_000_000_123 });
    expect(f).toHaveBeenCalledWith('/tiles/3/4.png', { signal });
    expect(decode).toHaveBeenCalledOnce();
  });

  it('treats a 404 as an empty tile of version 0, so every pixel comes from the real-time channel', async () => {
    const { decode, source } = mk(new Response(null, { status: 404 }));
    expect(await source.loadTile(0, 0, signal)).toEqual({ rgba: null, version: 0 });
    expect(decode).not.toHaveBeenCalled();
  });

  it('fails (so the tile is retried) on server errors', async () => {
    await expect(mk(new Response(null, { status: 503 })).source.loadTile(0, 0, signal)).rejects.toThrow('HTTP 503');
  });

  it('refuses the SPA fallback page served with a 200', async () => {
    const html = new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } });
    await expect(mk(html).source.loadTile(0, 0, signal)).rejects.toThrow(/not a PNG/);
  });

  it.each([undefined, 'abc', '-1', '1.5', '9'.repeat(20)])('refuses a missing or invalid X-Tile-Version (%s)', async (v) => {
    const res = png();
    if (v === undefined) res.headers.delete('X-Tile-Version');
    else res.headers.set('X-Tile-Version', v);
    await expect(mk(res).source.loadTile(0, 0, signal)).rejects.toThrow(/X-Tile-Version/);
  });
});
