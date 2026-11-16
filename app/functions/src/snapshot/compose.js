// Composes the /snapshot image (pure, unit tested).
//
// The grid is 100 000 x 100 000: a 1:1 image of it would be 40 GB of RGBA.
// The snapshot shows the painted area instead: the bounding box of the visible
// pixels with a margin, 1:1 when it fits in MAX_SIDE, otherwise downscaled
// (one image pixel per k x k block, the most recently painted pixel wins).
import { GRID_SIZE } from "../lib/events.js";
import { BACKGROUND } from "../lib/canvas.js";

export const MAX_SIDE = 2048;
export const MIN_SIDE = 512;
const MARGIN = 8;
const EMPTY_SIDE = 64;

/**
 * @param {Array<{ x: number, y: number, c: number, t: number }>} pixels  visible pixels (t: epoch ms)
 * @param {object} [options]
 * @param {number} [options.maxSide]
 * @returns {{ x0: number, y0: number, side: number, factor: number, upscale: number, width: number, height: number, rgba: Uint8Array }}
 *   the grid square [x0, x0 + side)^2, rendered at 1 / factor then enlarged by upscale
 */
export function composeSnapshot(pixels, { maxSide = MAX_SIDE } = {}) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y } of pixels) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  // A square around the painted area (the centre of the grid when empty).
  let side;
  let cx;
  let cy;
  if (pixels.length === 0) {
    side = EMPTY_SIDE;
    cx = GRID_SIZE / 2;
    cy = GRID_SIZE / 2;
  } else {
    side = Math.min(GRID_SIZE, Math.max(maxX - minX, maxY - minY) + 1 + 2 * MARGIN);
    cx = Math.floor((minX + maxX + 1) / 2);
    cy = Math.floor((minY + maxY + 1) / 2);
  }
  const x0 = Math.min(Math.max(0, cx - Math.floor(side / 2)), GRID_SIZE - side);
  const y0 = Math.min(Math.max(0, cy - Math.floor(side / 2)), GRID_SIZE - side);

  const factor = Math.ceil(side / maxSide);
  const cells = Math.ceil(side / factor);
  const upscale = Math.max(1, Math.ceil(MIN_SIDE / cells));
  const out = cells * upscale;

  // Most recent pixel of each cell.
  const colour = new Int32Array(cells * cells).fill(-1);
  const time = new Float64Array(cells * cells).fill(-Infinity);
  for (const { x, y, c, t } of pixels) {
    if (x < x0 || y < y0 || x >= x0 + side || y >= y0 + side) continue;
    const i = Math.floor((y - y0) / factor) * cells + Math.floor((x - x0) / factor);
    if (t >= time[i]) {
      time[i] = t;
      colour[i] = c;
    }
  }

  const rgba = new Uint8Array(out * out * 4);
  for (let cy2 = 0; cy2 < cells; cy2++)
    for (let cx2 = 0; cx2 < cells; cx2++) {
      const c = colour[cy2 * cells + cx2];
      const rgb = c < 0 ? BACKGROUND : c;
      for (let dy = 0; dy < upscale; dy++)
        for (let dx = 0; dx < upscale; dx++) {
          const i = ((cy2 * upscale + dy) * out + cx2 * upscale + dx) * 4;
          rgba[i] = (rgb >> 16) & 0xff;
          rgba[i + 1] = (rgb >> 8) & 0xff;
          rgba[i + 2] = rgb & 0xff;
          rgba[i + 3] = 0xff;
        }
    }
  return { x0, y0, side, factor, upscale, width: out, height: out, rgba };
}

/** Object name of a snapshot: timestamped, and the same for every delivery of one request. */
export function snapshotObjectName(requestedAt, requestId) {
  const iso = new Date(requestedAt).toISOString(); // 2026-11-16T12:00:00.000Z
  const day = iso.slice(0, 10).replaceAll("-", "/");
  return `snapshots/${day}/${iso.replace(/[:.]/g, "-")}_${requestId}.png`;
}
