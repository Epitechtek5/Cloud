import { TILE_SIZE, type TileRaster, type TileSource } from '../../contract';
import { readPngVersion } from './pngVersion';

export interface TileDeps {
  /** RuntimeConfig.tilesBase, without trailing slash. */
  base: string;
  fetch: typeof fetch;
  /** PNG bytes -> RGBA (TILE_SIZE * TILE_SIZE * 4). Replaceable in tests (no canvas in Node). */
  decode?: (png: Blob) => Promise<Uint8ClampedArray>;
}

/** Alpha is 0 or 255 in our rasters, so the canvas premultiplication does not alter any color. */
async function decodePng(png: Blob): Promise<Uint8ClampedArray> {
  const bitmap = await createImageBitmap(png, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try {
    if (bitmap.width !== TILE_SIZE || bitmap.height !== TILE_SIZE) {
      throw new Error(`Tile raster is ${bitmap.width}x${bitmap.height}, expected ${TILE_SIZE}x${TILE_SIZE}`);
    }
    const ctx = new OffscreenCanvas(TILE_SIZE, TILE_SIZE).getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('No 2d canvas available to decode a tile');
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
  } finally {
    bitmap.close();
  }
}

/**
 * `GET {base}/{tx}/{ty}.png` (docs/frontend-contract.md section 2): a 256x256 PNG served from the
 * private bucket by the load balancer, with its version (the time of the newest pixel it contains)
 * inside the PNG. A 404 means "nothing painted here since the last clear": the real-time channel then
 * supplies every pixel (from `max(0, clearedAt)`, see TileManager).
 */
export function createTileSource(d: TileDeps): TileSource {
  const decode = d.decode ?? decodePng;
  return {
    async loadTile(tx, ty, signal): Promise<TileRaster> {
      const res = await d.fetch(`${d.base}/${tx}/${ty}.png`, { signal });
      if (res.status === 404) return { rgba: null, version: 0 };
      if (!res.ok) throw new Error(`Tile ${tx},${ty} failed (HTTP ${res.status})`);
      // A CDN with a single-page fallback answers a missing route with index.html and a 200: refuse it
      // instead of showing an empty tile that would then be subscribed from the wrong version.
      if (!(res.headers.get('Content-Type') ?? '').toLowerCase().startsWith('image/png')) {
        throw new Error(`Tile ${tx},${ty} is not a PNG (is the tile service deployed?)`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      let version: number;
      try {
        version = readPngVersion(bytes);
      } catch (e) {
        throw new Error(`Tile ${tx},${ty}: ${(e as Error).message}`, { cause: e });
      }
      return { rgba: await decode(new Blob([bytes], { type: 'image/png' })), version };
    },
  };
}
