import { describe, expect, it } from 'vitest';
import type { PixelDelta } from '../contract';
import { createMockBackend } from './mock';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The mock accepts a draw after ~40 ms and commits it ~80 ms later.
const SETTLE = 200;

describe('mock backend: raster version and subscription cursor', () => {
  it('delivers exactly the pixels the raster misses, then live deltas', async () => {
    const { api, tiles, realtime } = createMockBackend({ latency: 0, botRate: 0, rateLimit: 1000 });
    const signal = new AbortController().signal;

    await api.draw([{ x: 5, y: 5, color: 0xff0000 }], 'b1');
    await sleep(SETTLE);
    const raster = await tiles.loadTile(0, 0, signal); // includes pixel (5,5)

    // Drawn after the raster was cut, before the tile subscribes: the raster does not have it.
    await api.draw([{ x: 6, y: 6, color: 0x00ff00 }], 'b2');
    await sleep(SETTLE);

    const received: PixelDelta[][] = [];
    const stop = realtime.subscribeTile(0, 0, (d) => received.push(d), { since: raster.version });
    await sleep(0);
    expect(received).toHaveLength(1);
    expect(received[0]!.map((d) => [d.x, d.y])).toEqual([[6, 6]]); // (5,5) is NOT replayed

    await api.draw([{ x: 7, y: 7, color: 0x0000ff }], 'b3');
    await sleep(SETTLE);
    expect(received.flat().map((d) => [d.x, d.y])).toEqual([
      [6, 6],
      [7, 7],
    ]);

    stop();
    await api.draw([{ x: 8, y: 8, color: 0xffffff }], 'b4');
    await sleep(SETTLE);
    expect(received.flat()).toHaveLength(2); // nothing after unsubscribe
  });

  it('gives an empty tile version 0 and a seeded tile a version older than anything drawn live', async () => {
    const { tiles } = createMockBackend({ latency: 0, botRate: 0 });
    const signal = new AbortController().signal;
    let empty = 0;
    let seeded = 0;
    for (let ty = 0; ty < 6 && (!empty || !seeded); ty++) {
      for (let tx = 0; tx < 6; tx++) {
        const r = await tiles.loadTile(tx, ty, signal);
        if (r.rgba === null) {
          expect(r.version).toBe(0);
          empty++;
        } else {
          expect(r.version).toBeGreaterThan(0);
          expect(r.version).toBeLessThan(Date.now());
          seeded++;
        }
      }
    }
    expect(empty).toBeGreaterThan(0);
    expect(seeded).toBeGreaterThan(0);
  });
});
