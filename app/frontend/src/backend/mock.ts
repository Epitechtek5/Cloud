// In-browser fake backend implementing the contract (phase 0). It lets the whole
// frontend be developed and tested without any cloud resource, and simulates
// "other users" drawing so the real-time path can be seen working.
import {
  GRID_SIZE,
  TILE_SIZE,
  type Backend,
  type DrawPixel,
  type PixelDelta,
  type PixelInfo,
  type SessionState,
  type UserEvent,
} from '../contract';
import { tileKey, tileOfPixel } from '../canvas/geometry';
import { PALETTE } from '../canvas/palette';

const SEED_TS = Date.UTC(2026, 0, 1);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic pseudo-artwork so the whole grid looks populated. */
function generateTile(tx: number, ty: number): Uint8ClampedArray | null {
  const rnd = mulberry32((tx * 73856093) ^ (ty * 19349663) ^ 0x9e3779b9);
  if (rnd() < 0.55) return null;
  const rgba = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
  const rects = 3 + Math.floor(rnd() * 8);
  for (let i = 0; i < rects; i++) {
    const w = 6 + Math.floor(rnd() * 70);
    const h = 6 + Math.floor(rnd() * 70);
    const x0 = Math.floor(rnd() * (TILE_SIZE - w));
    const y0 = Math.floor(rnd() * (TILE_SIZE - h));
    const c = PALETTE[Math.floor(rnd() * PALETTE.length)]!;
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const o = (y * TILE_SIZE + x) * 4;
        rgba[o] = (c >> 16) & 0xff;
        rgba[o + 1] = (c >> 8) & 0xff;
        rgba[o + 2] = c & 0xff;
        rgba[o + 3] = 255;
      }
    }
  }
  return rgba;
}

const seededAuthor = (x: number, y: number): string => String(1000 + (((x * 31) ^ (y * 17)) >>> 0) % 40);

export interface MockOptions {
  /** Average simulated tile latency, ms. */
  latency?: number;
  /** Simulated "other users" drawing live, pixels/second (0 disables). */
  botRate?: number;
  /** Pixels per minute allowed for the local user (the real default is 20). */
  rateLimit?: number;
}

export function createMockBackend({ latency = 60, botRate = 25, rateLimit }: MockOptions = {}): Backend {
  let limit = rateLimit ?? (Number(new URLSearchParams(globalThis.location?.search).get('limit')) || 20);
  const sent: number[] = []; // timestamps of the local user's accepted pixels (sliding minute)
  const used = (): number => {
    const cutoff = Date.now() - 60_000;
    while (sent.length && sent[0]! < cutoff) sent.shift();
    return sent.length;
  };
  const emitUser = (e: UserEvent) => userSubs.forEach((cb) => cb(e));
  const emitQuota = () => emitUser({ type: 'quota', remaining: Math.max(0, limit - used()), limit });
  const live = new Map<string, Map<string, PixelDelta>>(); // tile -> "x,y" -> delta
  const tileSubs = new Map<string, Set<(d: PixelDelta[]) => void>>();
  const sessionSubs = new Set<(s: SessionState) => void>();
  const userSubs = new Set<(e: UserEvent) => void>();
  const session: SessionState = { paused: false };
  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((res, rej) => {
      const t = setTimeout(res, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        rej(new DOMException('aborted', 'AbortError'));
      });
    });

  function commit(d: PixelDelta): void {
    const key = tileKey(tileOfPixel(d.x), tileOfPixel(d.y));
    let m = live.get(key);
    if (!m) live.set(key, (m = new Map()));
    m.set(`${d.x},${d.y}`, d);
    tileSubs.get(key)?.forEach((cb) => cb([d]));
  }

  if (botRate > 0) {
    setInterval(() => {
      const keys = [...tileSubs.keys()].filter((k) => (tileSubs.get(k)?.size ?? 0) > 0);
      if (keys.length === 0) return;
      for (let i = 0; i < Math.max(1, Math.round(botRate / 10)); i++) {
        const [tx, ty] = keys[Math.floor(Math.random() * keys.length)]!.split(':').map(Number) as [number, number];
        commit({
          x: tx * TILE_SIZE + Math.floor(Math.random() * TILE_SIZE),
          y: ty * TILE_SIZE + Math.floor(Math.random() * TILE_SIZE),
          color: PALETTE[Math.floor(Math.random() * PALETTE.length)]!,
          author: 'bot-' + (1 + Math.floor(Math.random() * 5)),
          ts: Date.now(),
        });
      }
    }, 100);
  }

  const backend: Backend = {
    tiles: {
      async loadTile(tx, ty, signal) {
        await sleep(latency * (0.5 + Math.random()), signal);
        const raster = generateTile(tx, ty) ?? null;
        const overlay = live.get(tileKey(tx, ty));
        if (!overlay || overlay.size === 0) return raster;
        const out = raster ?? new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
        for (const d of overlay.values()) {
          const o = ((d.y - ty * TILE_SIZE) * TILE_SIZE + (d.x - tx * TILE_SIZE)) * 4;
          out[o] = (d.color >> 16) & 0xff;
          out[o + 1] = (d.color >> 8) & 0xff;
          out[o + 2] = d.color & 0xff;
          out[o + 3] = 255;
        }
        return out;
      },
    },
    realtime: {
      subscribeTile(tx, ty, cb) {
        const key = tileKey(tx, ty);
        let set = tileSubs.get(key);
        if (!set) tileSubs.set(key, (set = new Set()));
        set.add(cb);
        return () => {
          set.delete(cb);
          if (set.size === 0) tileSubs.delete(key);
        };
      },
      subscribeSession(cb) {
        sessionSubs.add(cb);
        cb({ ...session });
        return () => sessionSubs.delete(cb);
      },
      subscribeUserEvents(cb) {
        userSubs.add(cb);
        cb({ type: 'quota', remaining: Math.max(0, limit - used()), limit });
        return () => userSubs.delete(cb);
      },
    },
    api: {
      async draw(pixels: DrawPixel[], batchId: string) {
        await sleep(40);
        // Like the real pipeline: accepted (202) now, processed asynchronously.
        setTimeout(() => {
          if (session.paused) {
            emitUser({ type: 'rejected', reason: 'paused', batchId, pixels });
            return;
          }
          const allowed = Math.max(0, limit - used());
          const accepted = pixels.slice(0, allowed);
          const refused = pixels.slice(allowed);
          for (const p of accepted) {
            sent.push(Date.now());
            commit({ x: p.x, y: p.y, color: p.color, author: 'me', ts: Date.now() });
          }
          if (refused.length) emitUser({ type: 'rejected', reason: 'rate_limited', batchId, pixels: refused });
          emitQuota();
        }, 80);
      },
      async pixelInfo(x, y): Promise<PixelInfo | null> {
        await sleep(30);
        const d = live.get(tileKey(tileOfPixel(x), tileOfPixel(y)))?.get(`${x},${y}`);
        if (d) return { x, y, color: d.color, author: d.author, authorName: `user-${d.author}`, ts: d.ts };
        const tx = tileOfPixel(x);
        const ty = tileOfPixel(y);
        const raster = generateTile(tx, ty);
        if (!raster) return null;
        const o = ((y - ty * TILE_SIZE) * TILE_SIZE + (x - tx * TILE_SIZE)) * 4;
        if (raster[o + 3] === 0) return null;
        const color = (raster[o]! << 16) | (raster[o + 1]! << 8) | raster[o + 2]!;
        const author = seededAuthor(x, y);
        return { x, y, color, author, authorName: `user-${author}`, ts: SEED_TS + ((x * 977 + y * 131) % 86_400_000) };
      },
    },
  };

  // Handy in the console / e2e tests: window.__mock.setPaused(true)
  (globalThis as unknown as { __mock?: unknown }).__mock = {
    setPaused(paused: boolean) {
      session.paused = paused;
      sessionSubs.forEach((cb) => cb({ ...session }));
    },
    setLimit(n: number) {
      limit = n;
      emitQuota();
    },
    gridSize: GRID_SIZE,
  };
  return backend;
}
