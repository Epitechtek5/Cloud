// Firestore documents -> contract types. Pure functions (no SDK), so the shape of the documents
// written by the workers (docs/data-model.md) is covered by unit tests without any emulator.
import type { DrawPixel, PixelDelta, SessionState, UserEvent } from '../../contract';

/** What we use of a Firestore `Timestamp` (kept structural: the SDK class is not needed here). */
export interface TimestampLike {
  toMillis(): number;
}

/** Fixed rate limit window of the draw worker (subject 3.3: pixels per minute). */
export const QUOTA_WINDOW_MS = 60_000;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isTimestamp = (v: unknown): v is TimestampLike => typeof (v as TimestampLike | null)?.toMillis === 'function';
type Doc = Record<string, unknown> | undefined;

/** `pixels/{x}_{y}` = `{ x, y, tile, c, a, an, t }`. Null for a document that is not a valid pixel. */
export function pixelFromDoc(d: Doc): PixelDelta | null {
  if (!d || !isInt(d.x) || !isInt(d.y) || !isInt(d.c) || typeof d.a !== 'string' || !isTimestamp(d.t)) return null;
  return { x: d.x, y: d.y, color: d.c, author: d.a, ts: d.t.toMillis() };
}

/** `session/state` = `{ paused, updatedAt }`; the document does not exist until the first /admin pause. */
export function sessionFromDoc(d: Doc): SessionState {
  return { paused: d?.paused === true };
}

/**
 * `users/{uid}` = `{ limit, used, windowStart }`. The worker only rewrites it when the user draws, so a
 * window that has elapsed since is still stored as "used": the quota is full again once it ends.
 */
export function quotaFromDoc(d: Doc, now: number): { event: UserEvent; resetAt: number | null } | null {
  if (!d || !isInt(d.limit) || !isInt(d.used)) return null;
  const windowEnd = isTimestamp(d.windowStart) ? d.windowStart.toMillis() + QUOTA_WINDOW_MS : 0;
  const active = now < windowEnd;
  return {
    event: { type: 'quota', limit: d.limit, remaining: Math.max(0, active ? d.limit - d.used : d.limit) },
    resetAt: active ? windowEnd : null,
  };
}

const REASONS = new Set(['rate_limited', 'paused', 'invalid']);

const asPixels = (v: unknown): DrawPixel[] =>
  Array.isArray(v) ? v.filter((p) => isInt(p?.x) && isInt(p?.y) && isInt(p?.color)).map((p) => ({ x: p.x, y: p.y, color: p.color })) : [];

/** `userEvents/{batchId}` = `{ uid, type: "rejected", reason, batchId, pixels, t, expireAt }`. */
export function rejectionFromDoc(d: Doc): UserEvent | null {
  if (!d || d.type !== 'rejected' || typeof d.batchId !== 'string' || typeof d.reason !== 'string' || !REASONS.has(d.reason)) return null;
  return { type: 'rejected', reason: d.reason as 'rate_limited' | 'paused' | 'invalid', batchId: d.batchId, pixels: asPixels(d.pixels) };
}
