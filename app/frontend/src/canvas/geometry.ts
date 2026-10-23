import { GRID_SIZE, TILE_SIZE, TILES_PER_SIDE } from '../contract';

/** `cx`/`cy`: grid coordinate shown at the screen center. `scale`: screen px per grid pixel. */
export interface Viewport {
  cx: number;
  cy: number;
  scale: number;
  width: number;
  height: number;
}

export interface TileRange {
  tx0: number;
  ty0: number;
  tx1: number;
  ty1: number;
}

// Below ~0.5 the viewport would span too many tiles; a downsampled overview
// layer is a later improvement, so we cap the zoom-out for now.
export const MIN_SCALE = 0.5;
export const MAX_SCALE = 48;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function screenToGrid(vp: Viewport, sx: number, sy: number): { x: number; y: number } {
  return {
    x: vp.cx + (sx - vp.width / 2) / vp.scale,
    y: vp.cy + (sy - vp.height / 2) / vp.scale,
  };
}

export function gridToScreen(vp: Viewport, x: number, y: number): { sx: number; sy: number } {
  return {
    sx: (x - vp.cx) * vp.scale + vp.width / 2,
    sy: (y - vp.cy) * vp.scale + vp.height / 2,
  };
}

export function clampViewport(vp: Viewport): Viewport {
  const scale = clamp(vp.scale, MIN_SCALE, MAX_SCALE);
  return {
    ...vp,
    scale,
    cx: clamp(vp.cx, 0, GRID_SIZE),
    cy: clamp(vp.cy, 0, GRID_SIZE),
  };
}

/** Zoom keeping the grid point under (sx, sy) fixed on screen. */
export function zoomAt(vp: Viewport, sx: number, sy: number, factor: number): Viewport {
  const scale = clamp(vp.scale * factor, MIN_SCALE, MAX_SCALE);
  const before = screenToGrid(vp, sx, sy);
  const next = { ...vp, scale };
  const after = screenToGrid(next, sx, sy);
  return clampViewport({ ...next, cx: vp.cx + (before.x - after.x), cy: vp.cy + (before.y - after.y) });
}

export function panBy(vp: Viewport, dxScreen: number, dyScreen: number): Viewport {
  return clampViewport({ ...vp, cx: vp.cx - dxScreen / vp.scale, cy: vp.cy - dyScreen / vp.scale });
}

export function visibleTileRange(vp: Viewport, margin = 0): TileRange {
  const tl = screenToGrid(vp, 0, 0);
  const br = screenToGrid(vp, vp.width, vp.height);
  const last = TILES_PER_SIDE - 1;
  return {
    tx0: clamp(Math.floor(tl.x / TILE_SIZE) - margin, 0, last),
    ty0: clamp(Math.floor(tl.y / TILE_SIZE) - margin, 0, last),
    tx1: clamp(Math.floor(br.x / TILE_SIZE) + margin, 0, last),
    ty1: clamp(Math.floor(br.y / TILE_SIZE) + margin, 0, last),
  };
}

export const tileKey = (tx: number, ty: number): string => `${tx}:${ty}`;
export const tileOfPixel = (v: number): number => Math.floor(v / TILE_SIZE);
export const inGrid = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE;

export function rgbToCss(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, '0')}`;
}
