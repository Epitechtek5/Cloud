import { GRID_SIZE, type DrawPixel, type Rgb } from '../contract';

export const MIN_BRUSH = 1;
export const MAX_BRUSH = 32;

export interface Point {
  x: number;
  y: number;
}

/** Every grid pixel on the segment (x0,y0)-(x1,y1), both ends included (Bresenham). */
export function line(x0: number, y0: number, x1: number, y1: number): Point[] {
  const out: Point[] = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    out.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

/** Top-left corner of the size x size square "centered" on a pixel (exact pixel when size is 1). */
export const brushOrigin = (c: number, size: number): number => c - Math.floor(size / 2);

/** Pixels covered by a square brush of `size` centered on `center`, clipped to the grid. */
export function stamp(center: Point, size: number): Point[] {
  const x0 = brushOrigin(center.x, size);
  const y0 = brushOrigin(center.y, size);
  const out: Point[] = [];
  for (let y = Math.max(0, y0); y < Math.min(GRID_SIZE, y0 + size); y++) {
    for (let x = Math.max(0, x0); x < Math.min(GRID_SIZE, x0 + size); x++) out.push({ x, y });
  }
  return out;
}

/** Brush stroke from `from` (or a single dab when null) to `to`: unique pixels, in grid. */
export function strokePixels(from: Point | null, to: Point, size: number, color: Rgb): DrawPixel[] {
  const seen = new Set<number>();
  const out: DrawPixel[] = [];
  for (const c of from ? line(from.x, from.y, to.x, to.y) : [to]) {
    for (const p of stamp(c, size)) {
      const key = p.y * GRID_SIZE + p.x; // < 1e10, exact as a JS number
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ x: p.x, y: p.y, color });
    }
  }
  return out;
}
