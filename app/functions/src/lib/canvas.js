// Reads painted pixels from Firestore and renders them to RGBA, for the
// images posted in Discord (/get) and the snapshots (/snapshot).
//
// `session/state.clearedAt` is the grid generation: `/admin clear` moves it
// forward, and every pixel written before it counts as erased
// (docs/data-model.md, "Effacement").
import { COLLECTIONS, SESSION_STATE, tilesOfRect } from "./grid.js";
import { toMillis } from "./firestore.js";

export const BACKGROUND = 0xffffff;

/** `{ paused, clearedAt }` of `session/state` (clearedAt in epoch ms, 0 if never cleared). */
export async function readSession(db, tx) {
  const ref = db.doc(SESSION_STATE);
  const snap = tx ? await tx.get(ref) : await ref.get();
  const data = snap.exists ? snap.data() : {};
  return { paused: data.paused === true, clearedAt: toMillis(data.clearedAt) ?? 0 };
}

/** True when a pixel document is still visible (written after the last clear). */
export function isVisible(pixel, clearedAt) {
  const t = toMillis(pixel.t);
  return t !== null && t > clearedAt;
}

/**
 * Pixels of the square region [x0, x0 + size) x [y0, y0 + size): one query per
 * tile (`tile ==`, single-field index), filtered to the region and to the
 * current grid generation.
 * @returns {Promise<Array<{ x: number, y: number, c: number }>>}
 */
export async function readRegion(db, { x0, y0, size, clearedAt = 0 }) {
  const tiles = tilesOfRect(x0, y0, size, size);
  const snaps = await Promise.all(
    tiles.map((tile) => db.collection(COLLECTIONS.pixels).where("tile", "==", tile).select("x", "y", "c", "t").get()),
  );
  const pixels = [];
  for (const snap of snaps)
    for (const doc of snap.docs) {
      const p = doc.data();
      if (p.x >= x0 && p.x < x0 + size && p.y >= y0 && p.y < y0 + size && isVisible(p, clearedAt))
        pixels.push({ x: p.x, y: p.y, c: p.c });
    }
  return pixels;
}

/**
 * RGBA image of a region, each grid pixel drawn as a `scale` x `scale` block.
 * Unpainted pixels get the background colour (opaque: Discord shows images on
 * a dark theme too).
 */
export function renderRegion(pixels, { x0, y0, width, height, scale = 1, background = BACKGROUND }) {
  const w = width * scale;
  const h = height * scale;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = (background >> 16) & 0xff;
    rgba[i * 4 + 1] = (background >> 8) & 0xff;
    rgba[i * 4 + 2] = background & 0xff;
    rgba[i * 4 + 3] = 0xff;
  }
  for (const { x, y, c } of pixels) {
    const gx = x - x0;
    const gy = y - y0;
    if (gx < 0 || gy < 0 || gx >= width || gy >= height) continue;
    for (let dy = 0; dy < scale; dy++)
      for (let dx = 0; dx < scale; dx++) {
        const i = ((gy * scale + dy) * w + gx * scale + dx) * 4;
        rgba[i] = (c >> 16) & 0xff;
        rgba[i + 1] = (c >> 8) & 0xff;
        rgba[i + 2] = c & 0xff;
      }
  }
  return { width: w, height: h, rgba };
}
