import {
  MAX_DRAW_BATCH,
  type Api,
  type DrawPixel,
  type PixelDelta,
  type RealtimeChannel,
  type Rgb,
  type SessionState,
  type Unsubscribe,
  type UserEvent,
} from '../contract';
import { inGrid } from '../canvas/geometry';

export interface PendingPixel {
  x: number;
  y: number;
  color: Rgb;
  /** Set when the pixel is sent; undefined while still queued. */
  batchId?: string;
}

export interface Quota {
  remaining: number;
  limit: number;
}

export type Notice = { level: 'info' | 'error'; text: string };

export interface DrawOptions {
  /** Coalesce a brush stroke into few requests (debounce, not polling). */
  flushMs?: number;
  /** Drop an optimistic pixel if neither an echo nor a rejection came back. */
  ackTimeoutMs?: number;
  newBatchId?: () => string;
}

const PAUSE_NOTICE_MS = 3000;

const key = (x: number, y: number): string => `${x},${y}`;

/**
 * Sends pixels through the authenticated gateway pipeline in batches and keeps an
 * optimistic layer on screen until the server state comes back through the real-time
 * channel. The server stays authoritative: rejected or lost pixels are rolled back.
 */
export class DrawController {
  readonly pending = new Map<string, PendingPixel>();
  paused = false;
  quota: Quota | null = null;

  private queue = new Map<string, PendingPixel>();
  private lastPausedNotice = -Infinity;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribers: Unsubscribe[] = [];
  private flushMs: number;
  private ackTimeoutMs: number;
  private newBatchId: () => string;

  constructor(
    private api: Api,
    realtime: RealtimeChannel,
    private hooks: { onChange(): void; onNotice(n: Notice): void },
    opts: DrawOptions = {},
  ) {
    this.flushMs = opts.flushMs ?? 100;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 15_000;
    this.newBatchId = opts.newBatchId ?? (() => crypto.randomUUID());
    this.unsubscribers.push(
      realtime.subscribeSession((s) => this.onSession(s)),
      realtime.subscribeUserEvents((e) => this.onUserEvent(e)),
    );
  }

  /** Optimistically paints pixels and queues them for sending. */
  paint(pixels: DrawPixel[]): void {
    if (this.paused) {
      // A stroke calls paint() on every pointer move: do not flood the user with toasts.
      const now = Date.now();
      if (now - this.lastPausedNotice > PAUSE_NOTICE_MS) {
        this.lastPausedNotice = now;
        this.hooks.onNotice({ level: 'error', text: 'Drawing is paused by an admin.' });
      }
      return;
    }
    let added = false;
    for (const p of pixels) {
      if (!inGrid(p.x, p.y) || !Number.isInteger(p.color) || p.color < 0 || p.color > 0xffffff) continue;
      const k = key(p.x, p.y);
      const cur = this.pending.get(k);
      if (cur && cur.color === p.color && cur.batchId === undefined) continue; // already queued
      const entry: PendingPixel = { x: p.x, y: p.y, color: p.color };
      this.pending.set(k, entry);
      this.queue.set(k, entry);
      added = true;
    }
    if (!added) return;
    this.hooks.onChange();
    this.flushTimer ??= setTimeout(() => this.flush(), this.flushMs);
  }

  /** Sends everything queued now (also called when a stroke ends). */
  flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const queued = [...this.queue.values()];
    this.queue.clear();
    for (let i = 0; i < queued.length; i += MAX_DRAW_BATCH) {
      this.send(queued.slice(i, i + MAX_DRAW_BATCH));
    }
  }

  /** Called for every delta applied to a tile: the server state replaces our guess. */
  onDelta(d: PixelDelta): void {
    if (this.pending.delete(key(d.x, d.y))) this.hooks.onChange();
  }

  dispose(): void {
    clearTimeout(this.flushTimer);
    this.unsubscribers.forEach((u) => u());
  }

  private send(entries: PendingPixel[]): void {
    const batchId = this.newBatchId();
    for (const e of entries) e.batchId = batchId;
    this.api
      .draw(
        entries.map(({ x, y, color }) => ({ x, y, color })),
        batchId,
      )
      .catch(() => {
        this.rollback(batchId);
        this.hooks.onNotice({ level: 'error', text: 'Could not send pixels. Check your connection.' });
      });
    setTimeout(() => this.rollback(batchId), this.ackTimeoutMs);
  }

  /** Removes the optimistic pixels still waiting on `batchId` (newer repaints are kept). */
  private rollback(batchId: string): void {
    let removed = false;
    for (const [k, p] of this.pending) {
      if (p.batchId === batchId) {
        this.pending.delete(k);
        removed = true;
      }
    }
    if (removed) this.hooks.onChange();
  }

  private onSession(s: SessionState): void {
    if (s.paused === this.paused) return;
    this.paused = s.paused;
    this.hooks.onNotice({ level: 'info', text: s.paused ? 'Drawing paused by an admin.' : 'Drawing resumed.' });
    this.hooks.onChange();
  }

  private onUserEvent(e: UserEvent): void {
    if (e.type === 'quota') {
      this.quota = { remaining: e.remaining, limit: e.limit };
      this.hooks.onChange();
      return;
    }
    this.rollback(e.batchId);
    const n = e.pixels.length;
    const text =
      e.reason === 'rate_limited'
        ? `Rate limit reached: ${n} pixel${n > 1 ? 's' : ''} not drawn.`
        : e.reason === 'paused'
          ? 'Drawing is paused: pixels not drawn.'
          : `${n} invalid pixel${n > 1 ? 's' : ''} rejected.`;
    this.hooks.onNotice({ level: 'error', text });
  }
}
