import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_DRAW_BATCH, type Api, type DrawPixel, type RealtimeChannel, type SessionState, type UserEvent } from '../contract';
import { DrawController, type Notice } from './drawController';

function setup(drawImpl?: Api['draw']) {
  let session: (s: SessionState) => void = () => {};
  let user: (e: UserEvent) => void = () => {};
  const realtime: RealtimeChannel = {
    subscribeTile: () => () => {},
    subscribeSession: (cb) => ((session = cb), () => {}),
    subscribeUserEvents: (cb) => ((user = cb), () => {}),
  };
  const draw = vi.fn(drawImpl ?? (async () => {}));
  const api: Api = { draw, pixelInfo: async () => null };
  const notices: Notice[] = [];
  const onChange = vi.fn();
  let n = 0;
  const ctl = new DrawController(api, realtime, { onChange, onNotice: (x) => notices.push(x) }, { newBatchId: () => `b${++n}` });
  return { ctl, draw, notices, onChange, emitSession: (s: SessionState) => session(s), emitUser: (e: UserEvent) => user(e) };
}
const px = (x: number, y = 0, color = 0xff0000): DrawPixel => ({ x, y, color });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('DrawController', () => {
  it('paints optimistically and coalesces a stroke into one request', () => {
    const { ctl, draw } = setup();
    ctl.paint([px(1), px(2)]);
    ctl.paint([px(3)]);
    expect(ctl.pending.size).toBe(3);
    expect(draw).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw.mock.calls[0]![0]).toHaveLength(3);
    expect(draw.mock.calls[0]![1]).toBe('b1');
  });

  it('splits large strokes into batches of at most MAX_DRAW_BATCH', () => {
    const { ctl, draw } = setup();
    ctl.paint(Array.from({ length: MAX_DRAW_BATCH * 2 + 10 }, (_, i) => px(i)));
    ctl.flush();
    expect(draw).toHaveBeenCalledTimes(3);
    expect(draw.mock.calls.map((c) => c[0].length)).toEqual([MAX_DRAW_BATCH, MAX_DRAW_BATCH, 10]);
    expect(new Set(draw.mock.calls.map((c) => c[1])).size).toBe(3); // distinct idempotency keys
  });

  it('the last color wins for a pixel painted twice before sending', () => {
    const { ctl, draw } = setup();
    ctl.paint([px(5, 5, 0xff0000)]);
    ctl.paint([px(5, 5, 0x00ff00)]);
    ctl.flush();
    expect(draw.mock.calls[0]![0]).toEqual([{ x: 5, y: 5, color: 0x00ff00 }]);
  });

  it('ignores invalid pixels', () => {
    const { ctl } = setup();
    ctl.paint([px(-1), px(0, 1e9), px(0, 0, 0x1000000), px(0, 0, 1.5)]);
    expect(ctl.pending.size).toBe(0);
  });

  it('removes the optimistic pixel when the real-time echo arrives', () => {
    const { ctl } = setup();
    ctl.paint([px(7, 7)]);
    ctl.flush();
    ctl.onDelta({ x: 7, y: 7, color: 0xff0000, author: 'me', ts: 1 });
    expect(ctl.pending.size).toBe(0);
  });

  it('rolls back a rejected batch and tells the user', () => {
    const { ctl, notices, emitUser } = setup();
    ctl.paint([px(1), px(2)]);
    ctl.flush();
    emitUser({ type: 'rejected', reason: 'rate_limited', batchId: 'b1', pixels: [px(1), px(2)] });
    expect(ctl.pending.size).toBe(0);
    expect(notices.at(-1)?.text).toMatch(/Rate limit reached: 2 pixels/);
  });

  it('a rejection of an old batch keeps a newer repaint of the same pixel', () => {
    const { ctl, emitUser } = setup();
    ctl.paint([px(1, 1, 0xff0000)]);
    ctl.flush(); // b1
    ctl.paint([px(1, 1, 0x0000ff)]); // repaint, not sent yet
    emitUser({ type: 'rejected', reason: 'rate_limited', batchId: 'b1', pixels: [px(1, 1)] });
    expect(ctl.pending.get('1,1')?.color).toBe(0x0000ff);
  });

  it('rolls back when the request itself fails', async () => {
    const { ctl, notices } = setup(async () => {
      throw new Error('network');
    });
    ctl.paint([px(1)]);
    ctl.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctl.pending.size).toBe(0);
    expect(notices.at(-1)?.text).toMatch(/Could not send/);
  });

  it('drops optimistic pixels that never get an answer', () => {
    const { ctl } = setup();
    ctl.paint([px(1)]);
    ctl.flush();
    vi.advanceTimersByTime(15_000);
    expect(ctl.pending.size).toBe(0);
  });

  it('refuses to paint while paused and recovers on resume', () => {
    const { ctl, draw, notices, emitSession } = setup();
    emitSession({ paused: true });
    ctl.paint([px(1)]);
    ctl.flush();
    expect(ctl.pending.size).toBe(0);
    expect(draw).not.toHaveBeenCalled();
    expect(notices.some((n) => /paused/i.test(n.text))).toBe(true);
    emitSession({ paused: false });
    ctl.paint([px(1)]);
    expect(ctl.pending.size).toBe(1);
  });

  it('does not flood notices while a stroke is painted during a pause', () => {
    const { ctl, notices, emitSession } = setup();
    emitSession({ paused: true });
    notices.length = 0;
    for (let i = 0; i < 20; i++) ctl.paint([px(i)]);
    expect(notices).toHaveLength(1);
    vi.advanceTimersByTime(3001);
    ctl.paint([px(1)]);
    expect(notices).toHaveLength(2);
  });

  it('tracks the quota sent by the server', () => {
    const { ctl, emitUser } = setup();
    emitUser({ type: 'quota', remaining: 12, limit: 20 });
    expect(ctl.quota).toEqual({ remaining: 12, limit: 20 });
  });
});
