import { describe, expect, it, vi } from 'vitest';
import {
  TILE_SIZE,
  type PixelDelta,
  type RealtimeChannel,
  type TileRaster,
  type TileSource,
} from '../contract';
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

interface Options {
  /** Deltas the channel delivers synchronously when a tile subscribes (the "first snapshot"). */
  backlog?: Record<string, PixelDelta[]>;
}

function setup({ backlog = {} }: Options = {}) {
  const listeners = new Map<string, (d: PixelDelta[]) => void>();
  const since = new Map<string, number>();
  const unsub = vi.fn();
  const events: string[] = []; // order of loads and subscriptions
  const realtime: RealtimeChannel = {
    subscribeTile: (tx, ty, cb, options) => {
      const key = `${tx}:${ty}`;
      events.push(`subscribe ${key}`);
      listeners.set(key, cb);
      since.set(key, options.since);
      const initial = backlog[key];
      if (initial) cb(initial);
      return () => {
        unsub();
        listeners.delete(key);
      };
    },
    subscribeSession: () => () => {},
    subscribeUserEvents: () => () => {},
  };
  const loads: { resolve: (r: TileRaster) => void; reject: (e: Error) => void; signal: AbortSignal }[] = [];
  const source: TileSource = {
    loadTile: (tx, ty, signal) => {
      events.push(`load ${tx}:${ty}`);
      return new Promise((resolve, reject) => loads.push({ resolve, reject, signal }));
    },
  };
  const surfaces = new Map<string, FakeSurface>();
  const onChange = vi.fn();
  const mgr = new TileManager(
    source,
    realtime,
    (tx, ty) => {
      const s = new FakeSurface();
      surfaces.set(`${tx}:${ty}`, s);
      return s;
    },
    onChange,
  );
  /** Resolves every pending raster load with this version (rgba = null for an empty tile). */
  const load = (version = 0, rgba: Uint8ClampedArray | null = new Uint8ClampedArray(4)) =>
    loads.splice(0).forEach((l) => l.resolve({ rgba, version }));
  return { mgr, listeners, since, unsub, surfaces, onChange, load, loads, events };
}

const delta = (x: number, y: number, color: number): PixelDelta => ({ x, y, color, author: 'u', ts: 1 });
const flush = () => new Promise((r) => setTimeout(r, 0));
const ONE_TILE = { tx0: 0, ty0: 0, tx1: 0, ty1: 0 };

describe('TileManager', () => {
  it('loads the raster first, then subscribes from the raster version', async () => {
    const { mgr, listeners, since, surfaces, load, events } = setup();
    mgr.setVisible(ONE_TILE);
    expect(events).toEqual(['load 0:0']); // nothing subscribed yet
    expect(listeners.size).toBe(0);
    expect(mgr.get(0, 0)).toBeUndefined(); // not ready yet

    load(1234);
    await flush();

    expect(events).toEqual(['load 0:0', 'subscribe 0:0']);
    expect(since.get('0:0')).toBe(1234);
    expect(surfaces.get('0:0')!.log).toEqual(['raster']);
    expect(mgr.get(0, 0)).toBeDefined();
  });

  it('subscribes an empty tile from version 0 without painting a raster', async () => {
    const { mgr, since, surfaces, load } = setup();
    mgr.setVisible(ONE_TILE);
    load(0, null);
    await flush();
    expect(since.get('0:0')).toBe(0);
    expect(surfaces.get('0:0')!.log).toEqual([]);
    expect(mgr.get(0, 0)).toBeDefined();
  });

  it('applies the first snapshot of the channel on top of the raster', async () => {
    // The channel replies synchronously inside subscribeTile: the raster must already be in place.
    const { mgr, surfaces, load } = setup({ backlog: { '0:0': [delta(3, 4, 0xff0000)] } });
    mgr.setVisible(ONE_TILE);
    load(10);
    await flush();
    expect(surfaces.get('0:0')!.log).toEqual(['raster', 'set 3,4 #ff0000']);
  });

  it('applies live deltas once ready and notifies for redraw', async () => {
    const { mgr, listeners, surfaces, load, onChange } = setup();
    mgr.setVisible({ tx0: 1, ty0: 0, tx1: 1, ty1: 0 });
    load(0, null);
    await flush();
    onChange.mockClear();
    listeners.get('1:0')!([delta(TILE_SIZE + 5, 2, 0x00ff00), delta(TILE_SIZE + 6, 2, -1)]);
    expect(surfaces.get('1:0')!.log).toEqual(['set 5,2 #00ff00', 'clear 6,2']);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('asks for a redraw when a raster arrives', async () => {
    const { mgr, load, onChange } = setup();
    mgr.setVisible(ONE_TILE);
    expect(onChange).not.toHaveBeenCalled();
    load(5);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('evicts and unsubscribes tiles that leave the kept range', async () => {
    const { mgr, listeners, unsub, load } = setup();
    mgr.setVisible({ tx0: 0, ty0: 0, tx1: 1, ty1: 0 });
    load(1);
    await flush();
    expect(mgr.size).toBe(2);
    mgr.setVisible({ tx0: 1, ty0: 0, tx1: 1, ty1: 0 });
    expect(mgr.size).toBe(1);
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(listeners.has('0:0')).toBe(false);
  });

  it('never subscribes a tile that left the range while its raster was loading', async () => {
    const { mgr, listeners, loads, load, events } = setup();
    mgr.setVisible(ONE_TILE);
    const [pending] = loads;
    mgr.setVisible({ tx0: 5, ty0: 5, tx1: 5, ty1: 5 }); // 0:0 is evicted, 5:5 opens
    expect(pending!.signal.aborted).toBe(true);
    load(7); // the late raster of 0:0 (and the one of 5:5) resolve
    await flush();
    expect(events).not.toContain('subscribe 0:0');
    expect(listeners.has('0:0')).toBe(false);
    expect(listeners.has('5:5')).toBe(true);
  });

  it('forgets a tile whose raster failed so the next viewport change retries it', async () => {
    const { mgr, listeners, loads, events } = setup();
    mgr.setVisible(ONE_TILE);
    loads[0]!.reject(new Error('network'));
    await flush();
    expect(mgr.size).toBe(0);
    expect(listeners.size).toBe(0);
    mgr.setVisible(ONE_TILE);
    expect(events.filter((e) => e === 'load 0:0')).toHaveLength(2);
  });

  it('does not open a tile twice', () => {
    const { mgr, events } = setup();
    mgr.setVisible(ONE_TILE);
    mgr.setVisible(ONE_TILE);
    expect(mgr.size).toBe(1);
    expect(events).toEqual(['load 0:0']);
  });

  it('ignores deltas that do not belong to the tile', async () => {
    const { mgr, listeners, surfaces, load } = setup();
    mgr.setVisible(ONE_TILE);
    load(0, null);
    await flush();
    listeners.get('0:0')!([delta(TILE_SIZE + 1, 0, 0xffffff)]);
    expect(surfaces.get('0:0')!.log).toEqual([]);
  });
});
