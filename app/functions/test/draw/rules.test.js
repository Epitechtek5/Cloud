import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRateLimit, decideBatch, drawReply, uniquePixels } from "../../src/draw/rules.js";
import { loadDrawConfig } from "../../src/draw/config.js";

const W = 60_000;
const px = (n, color = 1) => Array.from({ length: n }, (_, i) => ({ x: i, y: 0, color }));

test("a fresh window grants up to the default limit", () => {
  const q = applyRateLimit({ user: {}, requested: 21, now: 1000, defaultLimit: 20, windowMs: W });
  assert.deepEqual(q, { granted: 20, limit: 20, used: 20, windowStart: 1000, retryAfterMs: W });
});

test("the window keeps counting, then resets after windowMs", () => {
  const user = { used: 15, windowStart: 1000 };
  assert.equal(applyRateLimit({ user, requested: 10, now: 30_000, defaultLimit: 20, windowMs: W }).granted, 5);
  assert.equal(applyRateLimit({ user, requested: 10, now: 30_000, defaultLimit: 20, windowMs: W }).retryAfterMs, 31_000);
  const reset = applyRateLimit({ user, requested: 10, now: 61_000, defaultLimit: 20, windowMs: W });
  assert.deepEqual([reset.granted, reset.used, reset.windowStart], [10, 10, 61_000]);
  // A window start in the future (clock skew between instances) restarts the window.
  assert.equal(applyRateLimit({ user: { used: 20, windowStart: 90_000 }, requested: 1, now: 30_000, defaultLimit: 20, windowMs: W }).granted, 1);
});

test("the /admin ratelimit override replaces the default, 0 blocks", () => {
  assert.equal(applyRateLimit({ user: { override: 100 }, requested: 50, now: 0, defaultLimit: 20, windowMs: W }).granted, 50);
  assert.equal(applyRateLimit({ user: { override: 0 }, requested: 1, now: 0, defaultLimit: 20, windowMs: W }).granted, 0);
  assert.equal(applyRateLimit({ user: { override: null }, requested: 30, now: 0, defaultLimit: 20, windowMs: W }).limit, 20);
  assert.equal(applyRateLimit({ user: { used: 25, windowStart: 0 }, requested: 1, now: 1, defaultLimit: 20, windowMs: W }).granted, 0);
});

test("duplicate pixels in a batch are written once, last colour wins", () => {
  const out = uniquePixels([{ x: 1, y: 1, color: 1 }, { x: 2, y: 2, color: 2 }, { x: 1, y: 1, color: 3 }]);
  assert.deepEqual(out, [{ x: 2, y: 2, color: 2 }, { x: 1, y: 1, color: 3 }]);
});

test("decideBatch: partial acceptance when over quota, everything rejected when paused", () => {
  const over = decideBatch({ pixels: px(21), paused: false, user: {}, now: 0, defaultLimit: 20, windowMs: W });
  assert.equal(over.accepted.length, 20);
  assert.deepEqual(over.rejected, [{ x: 20, y: 0, color: 1 }]);
  assert.equal(over.reason, "rate_limited");

  const ok = decideBatch({ pixels: px(3), paused: false, user: {}, now: 0, defaultLimit: 20, windowMs: W });
  assert.equal(ok.reason, null);

  const paused = decideBatch({ pixels: px(3), paused: true, user: {}, now: 0, defaultLimit: 20, windowMs: W });
  assert.deepEqual([paused.accepted.length, paused.rejected.length, paused.reason, paused.quota], [0, 3, "paused", null]);
});

test("drawReply tells the /draw author what happened", () => {
  const pixel = { x: 1, y: 2, color: 0xff };
  assert.match(drawReply({ accepted: [pixel], reason: null }, pixel).content, /\(1, 2\) painted #0000ff/);
  assert.match(drawReply({ accepted: [], reason: "paused" }, pixel).content, /paused/);
  assert.match(drawReply({ accepted: [], reason: "rate_limited", quota: { limit: 20, retryAfterMs: 1500 } }, pixel).content, /20 pixels per minute\), try again in 2 s/);
  assert.match(drawReply({ accepted: [], reason: "rate_limited" }, pixel).content, /0 pixels per minute/);
});

test("configuration defaults to 20 pixels per 60 s", () => {
  assert.deepEqual(loadDrawConfig({}), { defaultLimit: 20, windowMs: 60_000 });
  assert.deepEqual(loadDrawConfig({ DEFAULT_RATE_LIMIT: "5", RATE_WINDOW_SECONDS: "10" }), { defaultLimit: 5, windowMs: 10_000 });
  assert.throws(() => loadDrawConfig({ DEFAULT_RATE_LIMIT: "-1" }), /DEFAULT_RATE_LIMIT/);
  assert.throws(() => loadDrawConfig({ RATE_WINDOW_SECONDS: "x" }), /RATE_WINDOW_SECONDS/);
});
