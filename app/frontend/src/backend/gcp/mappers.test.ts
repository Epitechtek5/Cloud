import { describe, expect, it } from 'vitest';
import { pixelFromDoc, QUOTA_WINDOW_MS, quotaFromDoc, rejectionFromDoc, sessionFromDoc } from './mappers';

const ts = (ms: number) => ({ toMillis: () => ms });
const pixel = { x: 10, y: 20, tile: '0_0', c: 0xff0000, a: '42', an: 'alice', t: ts(1000) };

describe('pixelFromDoc', () => {
  it('maps the worker document to a delta (time in ms)', () => {
    expect(pixelFromDoc(pixel)).toEqual({ x: 10, y: 20, color: 0xff0000, author: '42', ts: 1000 });
  });
  it.each([undefined, {}, { ...pixel, x: 1.5 }, { ...pixel, c: '1' }, { ...pixel, a: 42 }, { ...pixel, t: null }])('ignores %j', (d) => {
    expect(pixelFromDoc(d as never)).toBeNull();
  });
});

describe('sessionFromDoc', () => {
  it('is not paused while the document does not exist', () => {
    expect(sessionFromDoc(undefined)).toEqual({ paused: false });
    expect(sessionFromDoc({ paused: true })).toEqual({ paused: true });
    expect(sessionFromDoc({ paused: 'yes' })).toEqual({ paused: false });
  });
});

describe('quotaFromDoc', () => {
  const user = { limit: 20, used: 15, windowStart: ts(100_000) };
  it('counts what is left inside the current window and says when it ends', () => {
    expect(quotaFromDoc(user, 130_000)).toEqual({ event: { type: 'quota', remaining: 5, limit: 20 }, resetAt: 100_000 + QUOTA_WINDOW_MS });
  });
  it('gives the full limit once the window has ended', () => {
    expect(quotaFromDoc(user, 100_000 + QUOTA_WINDOW_MS)).toEqual({ event: { type: 'quota', remaining: 20, limit: 20 }, resetAt: null });
  });
  it('never goes below zero (override lowered under what was used)', () => {
    expect(quotaFromDoc({ ...user, limit: 10 }, 110_000)?.event).toEqual({ type: 'quota', remaining: 0, limit: 10 });
  });
  it('says nothing for a user who never drew', () => {
    expect(quotaFromDoc(undefined, 0)).toBeNull();
    expect(quotaFromDoc({ used: 1 }, 0)).toBeNull();
  });
});

describe('rejectionFromDoc', () => {
  const ev = { uid: '42', type: 'rejected', reason: 'rate_limited', batchId: 'b', pixels: [{ x: 1, y: 2, color: 3 }], t: ts(1) };
  it('maps a rejection and keeps only well formed pixels', () => {
    expect(rejectionFromDoc({ ...ev, pixels: [...ev.pixels, { x: 'a' }, null] })).toEqual({
      type: 'rejected',
      reason: 'rate_limited',
      batchId: 'b',
      pixels: [{ x: 1, y: 2, color: 3 }],
    });
  });
  it.each([undefined, { ...ev, type: 'quota' }, { ...ev, reason: 'cosmic_rays' }, { ...ev, batchId: 1 }])('ignores %j', (d) => {
    expect(rejectionFromDoc(d as never)).toBeNull();
  });
  it('tolerates a missing pixel list', () => {
    expect(rejectionFromDoc({ ...ev, pixels: undefined })).toMatchObject({ pixels: [] });
  });
});
