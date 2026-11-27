import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserEvent } from '../../contract';
import { createRealtimeChannel, type Doc, type RealtimeStore } from './realtime';

const ts = (ms: number) => ({ toMillis: () => ms });
const px = (x: number, t: number) => ({ x, y: 0, tile: '0_0', c: 1, a: 'u', an: 'u', t: ts(t) });

function fakeStore() {
  const s = {
    tile: vi.fn(), session: vi.fn(), user: vi.fn(), rej: vi.fn(),
    stops: { tile: vi.fn(), session: vi.fn(), user: vi.fn(), rej: vi.fn() },
  };
  const store: RealtimeStore = {
    watchTile: (...a) => (s.tile(...a), s.stops.tile),
    watchSession: (...a) => (s.session(...a), s.stops.session),
    watchUser: (...a) => (s.user(...a), s.stops.user),
    watchRejections: (...a) => (s.rej(...a), s.stops.rej),
  };
  return { s, store };
}

let clock = 0;
beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_000_000;
});
afterEach(() => vi.useRealTimers());
const channel = (store: RealtimeStore, onError = vi.fn()) => ({ onError, ch: createRealtimeChannel({ store, uid: '42', now: () => clock, onError }) });

describe('subscribeTile', () => {
  it('queries the tile "tx_ty" after the raster version and delivers deltas', () => {
    const { s, store } = fakeStore();
    const cb = vi.fn();
    const stop = channel(store).ch.subscribeTile(3, 4, cb, { since: 555 });
    const [tile, since, onDocs] = s.tile.mock.calls[0] as [string, number, (d: Doc[]) => void];
    expect([tile, since]).toEqual(['3_4', 555]);
    onDocs([px(1, 600), px(2, 700)]);
    expect(cb).toHaveBeenCalledWith([
      { x: 1, y: 0, color: 1, author: 'u', ts: 600 },
      { x: 2, y: 0, color: 1, author: 'u', ts: 700 },
    ]);
    stop();
    expect(s.stops.tile).toHaveBeenCalledOnce();
  });

  it('drops malformed documents and does not call back for an empty batch', () => {
    const { s, store } = fakeStore();
    const cb = vi.fn();
    channel(store).ch.subscribeTile(0, 0, cb, { since: 0 });
    const onDocs = s.tile.mock.calls[0]![2] as (d: Doc[]) => void;
    onDocs([{ x: 'bad' }, undefined]);
    onDocs([]);
    expect(cb).not.toHaveBeenCalled();
  });

  it('reports listener errors instead of swallowing them', () => {
    const { s, store } = fakeStore();
    const { ch, onError } = channel(store);
    ch.subscribeTile(1, 2, vi.fn(), { since: 0 });
    const err = new Error('permission-denied');
    (s.tile.mock.calls[0]![3] as (e: unknown) => void)(err);
    expect(onError).toHaveBeenCalledWith('tile 1,2', err);
  });
});

describe('subscribeSession', () => {
  it('maps the pause flag, false when the document is missing', () => {
    const { s, store } = fakeStore();
    const cb = vi.fn();
    channel(store).ch.subscribeSession(cb);
    const onDoc = s.session.mock.calls[0]![0] as (d: Doc) => void;
    onDoc(undefined);
    onDoc({ paused: true });
    expect(cb.mock.calls).toEqual([[{ paused: false, clearedAt: 0 }], [{ paused: true, clearedAt: 0 }]]);
  });
});

describe('subscribeUserEvents', () => {
  const setup = () => {
    const { s, store } = fakeStore();
    const events: UserEvent[] = [];
    const stop = channel(store).ch.subscribeUserEvents((e) => events.push(e));
    return {
      s, events, stop,
      user: s.user.mock.calls[0]![1] as (d: Doc) => void,
      rej: s.rej.mock.calls[0]![2] as (d: Doc[]) => void,
    };
  };

  it('listens to our own uid, only for rejections created after the page opened', () => {
    const { s } = setup();
    expect(s.user.mock.calls[0]![0]).toBe('42');
    expect(s.rej.mock.calls[0]!.slice(0, 2)).toEqual(['42', 1_000_000]);
  });

  it('turns the quota document into events and announces the full quota when the window ends', () => {
    const { user, events } = setup();
    user({ limit: 20, used: 18, windowStart: ts(clock - 10_000) });
    expect(events).toEqual([{ type: 'quota', remaining: 2, limit: 20 }]);
    vi.advanceTimersByTime(49_999);
    expect(events).toHaveLength(1);
    clock += 50_000;
    vi.advanceTimersByTime(1);
    expect(events.at(-1)).toEqual({ type: 'quota', remaining: 20, limit: 20 });
  });

  it('cancels the pending reset when the quota changes again, and on unsubscribe', () => {
    const { user, events, stop, s } = setup();
    user({ limit: 20, used: 1, windowStart: ts(clock) });
    user({ limit: 20, used: 2, windowStart: ts(clock) });
    vi.advanceTimersByTime(60_000);
    expect(events.filter((e) => e.type === 'quota' && e.remaining === 20)).toHaveLength(1);
    user({ limit: 20, used: 3, windowStart: ts(clock) });
    stop();
    vi.advanceTimersByTime(120_000);
    expect(events).toHaveLength(4);
    expect(s.stops.user).toHaveBeenCalledOnce();
    expect(s.stops.rej).toHaveBeenCalledOnce();
  });

  it('delivers rejections so the optimistic pixels are rolled back', () => {
    const { rej, events } = setup();
    rej([{ type: 'rejected', reason: 'paused', batchId: 'b1', pixels: [{ x: 1, y: 2, color: 3 }] }, { type: 'nope' }]);
    expect(events).toEqual([{ type: 'rejected', reason: 'paused', batchId: 'b1', pixels: [{ x: 1, y: 2, color: 3 }] }]);
  });
});
