import { describe, expect, it, vi } from 'vitest';
import { TILE_SIZE, type PixelDelta, type RealtimeChannel, type TileSource } from '../contract';
import { TileManager, type TileSurface } from './tileManager';

class FakeSurface implements TileSurface {
  log: string[] = [];
  putRaster() {
    this.log.push('raster');
  }
  setPixel(x: number, y: number, css: string) {
    this.log.push(`set ${x},${y} ${css}`);
  }
  clearPixel(x: number, y: number) {
    this.log.push(`clear ${x},${y}`);
  }
}

function setup(raster: Uint8ClampedArray | null = new Uint8ClampedArray(4)) {
  const listeners = new Map<string, (d: PixelDelta[]) => void>();
  const unsub = vi.fn();
  const realtime: RealtimeChannel = {
    subscribeTile: (tx, ty, cb) => {
      listeners.set(`${tx}:${ty}`, cb);
      return () => {
        unsub();
        listeners.delete(`${tx}:${ty}`);
      };
    },
    subscribeSession: () => () => {},
    subscribeUserEvents: () => () => {},
  };
  let resolveLoad!: (r: Uint8ClampedArray | null) => void;
  const source: TileSource = {
    loadTile: () => new Promise((res) => (resolveLoad = res)),
  };
  const surfaces = new Map<string, FakeSurface>();
  const onChange = vi.fn();
  const mgr = new TileManager(source, realtime, (tx, ty) => {
    const s = new FakeSurface();
    surfaces.set(`${tx}:${ty}`, s);
    return s;
  }, onChange);
  return { mgr, listeners, unsub, surfaces, onChange, load: () => resolveLoad(raster) };
}

const delta = (x: number, y: number, color: number): PixelDelta => ({ x, y, color, author: 'u', ts: 1 });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('TileManager', () => {
  it('subscribes before loading and replays deltas received while loading', async () => {
    const { mgr, listeners, surfaces, load } = setup();
    mgr.setVisible({ tx0: 0, ty0: 0, tx1: 0, ty1: 0 });
    expect(listeners.has('0:0')).toBe(true);
    expect(mgr.get(0, 0)).toBeUndefined(); // not ready yet

    listeners.get('0:0')!([delta(3, 4, 0xff0000)]); // arrives during load
    load();
    await flush();

    expect(surfaces.get('0:0')!.log).toEqual(['raster', 'set 3,4 #ff0000']);
    expect(mgr.get(0, 0)).toBeDefined();
  });

  it('applies live deltas once ready and notifies for redraw', async () => {
    const { mgr, listeners, surfaces, load, onChange } = setup(null);
    mgr.setVisible({ tx0: 1, ty0: 0, tx1: 1, ty1: 0 });
    load();
    await flush();
    onChange.mockClear();
    listeners.get('1:0')!([delta(TILE_SIZE + 5, 2, 0x00ff00), delta(TILE_SIZE + 6, 2, -1)]);
    expect(surfaces.get('1:0')!.log).toEqual(['set 5,2 #00ff00', 'clear 6,2']);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('evicts and unsubscribes tiles that leave the kept range', async () => {
    const { mgr, listeners, unsub, load } = setup();
    mgr.setVisible({ tx0: 0, ty0: 0, tx1: 1, ty1: 0 });
    load();
    await flush();
    expect(mgr.size).toBe(2);
    mgr.setVisible({ tx0: 1, ty0: 0, tx1: 1, ty1: 0 });
    expect(mgr.size).toBe(1);
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(listeners.has('0:0')).toBe(false);
  });

  it('does not open a tile twice', () => {
    const { mgr } = setup();
    mgr.setVisible({ tx0: 0, ty0: 0, tx1: 0, ty1: 0 });
    mgr.setVisible({ tx0: 0, ty0: 0, tx1: 0, ty1: 0 });
    expect(mgr.size).toBe(1);
  });

  it('ignores deltas that do not belong to the tile', async () => {
    const { mgr, listeners, surfaces, load } = setup(null);
    mgr.setVisible({ tx0: 0, ty0: 0, tx1: 0, ty1: 0 });
    load();
    await flush();
    listeners.get('0:0')!([delta(TILE_SIZE + 1, 0, 0xffffff)]);
    expect(surfaces.get('0:0')!.log).toEqual([]);
  });
});
