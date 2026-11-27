// /get from the tile rasters (#68): the painted pixels of a square region of
// the grid, with the same contract as `readRegion` of lib/canvas.js (which
// reads every pixel document of each tile) but from `raster + new pixels`
// (current.js). A tile that was painted a lot costs one PNG and a few new
// documents instead of up to 65 536 reads.
import { tilesOfRect } from "../lib/grid.js";
import { mapLimit } from "./bucket.js";
import { currentTile } from "./current.js";
import { colorAt, parseTile, pixelOffset, TILE_SIZE } from "./raster.js";

/**
 * @param {object} deps
 * @param {{ read: Function }} deps.bucket  src/tiles/bucket.js
 * @param {Function} deps.readPixels  current.js `readTilePixels`, bound to Firestore
 * @param {number} [deps.concurrency]
 * @returns {(region: { x0: number, y0: number, size: number, clearedAt?: number }) => Promise<Array<{ x: number, y: number, c: number }>>}
 */
export function createRasterRegionReader({ bucket, readPixels, concurrency = 9 }) {
  return async function readRegion({ x0, y0, size, clearedAt = 0 }) {
    const tiles = tilesOfRect(x0, y0, size, size).map(parseTile);

    const perTile = await mapLimit(tiles, concurrency, async ({ tx, ty }) => {
      const { rgba } = await currentTile({ bucket, readPixels, tx, ty, clearedAt });
      return regionPixels(rgba, tx, ty, { x0, y0, size });
    });
    return perTile.flat();
  };
}

/** Painted pixels of one tile raster that fall inside the region, as grid coordinates. */
export function regionPixels(rgba, tx, ty, { x0, y0, size }) {
  const fromX = Math.max(x0, tx * TILE_SIZE);
  const toX = Math.min(x0 + size, (tx + 1) * TILE_SIZE);
  const fromY = Math.max(y0, ty * TILE_SIZE);
  const toY = Math.min(y0 + size, (ty + 1) * TILE_SIZE);
  const pixels = [];
  for (let y = fromY; y < toY; y++)
    for (let x = fromX; x < toX; x++) {
      const c = colorAt(rgba, pixelOffset(x, y));
      if (c >= 0) pixels.push({ x, y, c });
    }
  return pixels;
}
