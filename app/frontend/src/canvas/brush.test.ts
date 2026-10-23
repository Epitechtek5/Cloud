import { describe, expect, it } from 'vitest';
import { GRID_SIZE } from '../contract';
import { line, stamp, strokePixels } from './brush';

describe('brush', () => {
  it('line includes both ends and has no gaps', () => {
    const l = line(0, 0, 5, 2);
    expect(l[0]).toEqual({ x: 0, y: 0 });
    expect(l[l.length - 1]).toEqual({ x: 5, y: 2 });
    for (let i = 1; i < l.length; i++) {
      expect(Math.abs(l[i]!.x - l[i - 1]!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(l[i]!.y - l[i - 1]!.y)).toBeLessThanOrEqual(1);
    }
  });

  it('line works in every direction and for a single point', () => {
    expect(line(3, 3, 3, 3)).toEqual([{ x: 3, y: 3 }]);
    expect(line(5, 5, 0, 0)).toHaveLength(6);
    expect(line(0, 4, 0, 0)).toHaveLength(5);
  });

  it('size 1 stamps exactly the pixel', () => {
    expect(stamp({ x: 10, y: 20 }, 1)).toEqual([{ x: 10, y: 20 }]);
  });

  it('stamps size*size pixels, clipped to the grid', () => {
    expect(stamp({ x: 50, y: 50 }, 5)).toHaveLength(25);
    const corner = stamp({ x: 0, y: 0 }, 5);
    expect(corner.every((p) => p.x >= 0 && p.y >= 0)).toBe(true);
    expect(corner.length).toBeLessThan(25);
    const far = stamp({ x: GRID_SIZE - 1, y: GRID_SIZE - 1 }, 4);
    expect(far.every((p) => p.x < GRID_SIZE && p.y < GRID_SIZE)).toBe(true);
  });

  it('a stroke yields unique pixels even when stamps overlap', () => {
    const px = strokePixels({ x: 100, y: 100 }, { x: 110, y: 100 }, 3, 0xff0000);
    const keys = px.map((p) => `${p.x},${p.y}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(px).toHaveLength(13 * 3); // centers 100..110 with size 3 cover x 99..111
  });

  it('a dab without a previous point is just the stamp', () => {
    expect(strokePixels(null, { x: 5, y: 5 }, 2, 0x00ff00)).toHaveLength(4);
  });
});
