import { describe, expect, it, vi } from 'vitest';
import { TILE_SIZE } from '../../contract';
import { createTileSource } from './tiles';

const rgba = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4).fill(7);

/** Minimal PNG framing with the renderer's tEXt chunk (pngVersion.test.ts covers the parsing). */
function pngBytes(version: string | null): Uint8Array<ArrayBuffer> {
  const chunk = (type: string, data: string) => {
    const n = data.length;
    return [0, 0, (n >>> 8) & 255, n & 255, ...[...type, ...data].map((c) => c.charCodeAt(0)), 0, 0, 0, 0];
  };
  const text = version === null ? [] : chunk('tEXt', `Tile-Version\0${version}`);
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', '\0'.repeat(13)), ...text, ...chunk('IEND', '')]);
}
const png = (version: string | null = '1700000000123') =>
  new Response(pngBytes(version), { headers: { 'Content-Type': 'image/png' } });
const mk = (res: Response) => {
  const f = vi.fn(async () => res);
  const decode = vi.fn(async (_png: Blob) => rgba);
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

  it.each([null, 'abc', '-1', '1.5', '9'.repeat(20)])('refuses a raster without a valid version inside (%s)', async (v) => {
    await expect(mk(png(v)).source.loadTile(0, 0, signal)).rejects.toThrow(/Tile 0,0: .*Tile-Version/);
  });

  it('hands the same bytes to the decoder', async () => {
    const { decode, source } = mk(png());
    await source.loadTile(0, 0, signal);
    const blob = decode.mock.calls[0]![0];
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(pngBytes('1700000000123'));
  });
});
