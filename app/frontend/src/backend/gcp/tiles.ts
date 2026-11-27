import { TILE_SIZE, type TileRaster, type TileSource } from '../../contract';

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
 * `GET {base}/{tx}/{ty}.png` (docs/frontend-contract.md section 2): a 256x256 PNG and the
 * `X-Tile-Version` header, the time of the newest pixel it contains. A 404 means "nothing
 * was ever painted here": the real-time channel then supplies every pixel (`since = 0`).
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
      const raw = res.headers.get('X-Tile-Version');
      const version = raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(version)) throw new Error(`Tile ${tx},${ty} has no valid X-Tile-Version header`);
      return { rgba: await decode(await res.blob()), version };
    },
  };
}
