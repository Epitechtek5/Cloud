import { describe, expect, it } from 'vitest';
import { GRID_SIZE, TILES_PER_SIDE } from '../contract';
import { MAX_SCALE, MIN_SCALE, panBy, screenToGrid, gridToScreen, tileOfPixel, visibleTileRange, zoomAt, type Viewport } from './geometry';

const vp = (over: Partial<Viewport> = {}): Viewport => ({ cx: 5000, cy: 5000, scale: 1, width: 800, height: 600, ...over });

describe('geometry', () => {
  it('screen <-> grid round-trips', () => {
    const v = vp({ scale: 4, cx: 123.5, cy: 987.25 });
    const g = screenToGrid(v, 211, 99);
    const s = gridToScreen(v, g.x, g.y);
    expect(s.sx).toBeCloseTo(211);
    expect(s.sy).toBeCloseTo(99);
  });

  it('zoomAt keeps the point under the cursor fixed', () => {
    const v = vp();
    const before = screenToGrid(v, 200, 150);
    const z = zoomAt(v, 200, 150, 2);
    const after = screenToGrid(z, 200, 150);
    expect(z.scale).toBe(2);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('clamps zoom to bounds', () => {
    expect(zoomAt(vp(), 0, 0, 1e6).scale).toBe(MAX_SCALE);
    expect(zoomAt(vp(), 0, 0, 1e-6).scale).toBe(MIN_SCALE);
  });

  it('pan stays inside the grid', () => {
    const p = panBy(vp({ cx: 10, cy: 10 }), 10_000, 10_000);
    expect(p.cx).toBe(0);
    expect(p.cy).toBe(0);
    const q = panBy(vp({ cx: GRID_SIZE - 10, cy: 0 }), -10_000, 0);
    expect(q.cx).toBe(GRID_SIZE);
  });

  it('only a handful of tiles are visible at a normal zoom', () => {
    const r = visibleTileRange(vp({ scale: 1 }));
    const count = (r.tx1 - r.tx0 + 1) * (r.ty1 - r.ty0 + 1);
    // worst case is 5x4 when the viewport straddles tile borders
    expect(count).toBeLessThanOrEqual(20);
  });

  it('tile range is clamped to the grid', () => {
    const r = visibleTileRange(vp({ cx: 0, cy: 0, scale: 1 }), 2);
    expect(r.tx0).toBe(0);
    expect(r.ty0).toBe(0);
    const far = visibleTileRange(vp({ cx: GRID_SIZE, cy: GRID_SIZE, scale: 1 }), 2);
    expect(far.tx1).toBe(TILES_PER_SIDE - 1);
  });

  it('stays bounded at the far corner of the 100k grid', () => {
    expect(tileOfPixel(GRID_SIZE - 1)).toBe(TILES_PER_SIDE - 1);
    const r = visibleTileRange(vp({ cx: GRID_SIZE - 1, cy: GRID_SIZE - 1, scale: 0.5, width: 1920, height: 1080 }), 1);
    expect(r.tx1).toBe(TILES_PER_SIDE - 1);
    expect((r.tx1 - r.tx0 + 1) * (r.ty1 - r.ty0 + 1)).toBeLessThanOrEqual(150);
  });
});
