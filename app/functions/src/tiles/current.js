// The current image of a tile: its raster plus the pixels painted since.
//
// This is the same recipe as the front (frontend contract §3): load the
// raster, read `t > version` from Firestore, apply. Both the tile renderer
// (which then stores the result) and /get (which only displays it) use it, so
// /get is exact even when the renderer is a few seconds behind, and neither
// ever reads a whole tile unless the tile has no raster yet.
import { isVisible } from "../lib/canvas.js";
import { firestoreTypes, toMillis } from "../lib/firestore.js";
import { COLLECTIONS } from "../lib/grid.js";
import { applyPixels, emptyRaster, isBlank, tileId, TILE_SIZE } from "./raster.js";

/**
 * Pixels of a tile written after `sinceMs` and after the last /admin clear,
 * oldest first. One query on the `(tile, t)` index, and only the new pixels.
 * @returns {Promise<Array<{ x: number, y: number, c: number, t: number }>>}  t in epoch ms, rounded down
 */
export async function readTilePixels(db, { tx, ty, sinceMs, clearedAt }) {
  const { Timestamp } = await firestoreTypes();
  const snap = await db
    .collection(COLLECTIONS.pixels)
    .where("tile", "==", tileId(tx, ty))
    .where("t", ">", Timestamp.fromMillis(sinceMs))
    .orderBy("t")
    .select("x", "y", "c", "t")
    .limit(TILE_SIZE * TILE_SIZE)
    .get();
  const pixels = [];
  for (const doc of snap.docs) {
    const p = doc.data();
    if (isVisible(p, clearedAt)) pixels.push({ x: p.x, y: p.y, c: p.c, t: toMillis(p.t) });
  }
  return pixels;
}

/**
 * @param {object} options
 * @param {{ read: Function }} options.bucket  src/tiles/bucket.js
 * @param {(query: { tx: number, ty: number, sinceMs: number, clearedAt: number }) => Promise<Array<{ x: number, y: number, c: number, t: number }>>} options.readPixels
 * @param {number} options.tx
 * @param {number} options.ty
 * @param {number} options.clearedAt  epoch ms of the last /admin clear (0: never)
 * @returns {Promise<{ rgba: Uint8Array, version: number, stored: object | null, upToDate: boolean, blank: boolean }>}
 *   `version`: time of the newest pixel in `rgba` (0 when blank), rounded down;
 *   `upToDate`: the stored raster already is this image (nothing new to write), even if pixels were read
 */
export async function currentTile({ bucket, readPixels, tx, ty, clearedAt }) {
  const stored = await bucket.read(tx, ty);
  // A raster at least as old as the last clear shows erased pixels: start again from nothing.
  const base = stored && stored.version > clearedAt ? stored : null;
  const sinceMs = base ? base.version : clearedAt;

  const pixels = await readPixels({ tx, ty, sinceMs, clearedAt });
  const rgba = base ? base.rgba : emptyRaster();
  const changed = applyPixels(rgba, pixels);

  // Ordered by t: the last pixel is the newest.
  const version = Math.max(base?.version ?? 0, pixels.at(-1)?.t ?? 0);
  // Compared on the image, not on the number of pixels read: the version is
  // rounded down to the millisecond while `t` has microseconds, so the newest
  // pixel of the raster comes back at every read (`t > version`) without being
  // new. Nothing to write then; the raster keeps its older version, which only
  // makes the front read that pixel again (harmless, the same colour).
  const upToDate = base !== null && !changed;
  return { rgba, version, stored, upToDate, blank: isBlank(rgba) };
}
