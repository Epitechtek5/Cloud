import { test } from "node:test";
import assert from "node:assert/strict";
import { loadReaderConfig, loadRendererConfig, tilesBucketName } from "../../src/tiles/config.js";

test("the bucket is required", () => {
  assert.throws(() => tilesBucketName({}), /TILES_BUCKET/);
  assert.throws(() => loadRendererConfig({}), /TILES_BUCKET/);
  assert.throws(() => loadReaderConfig({}), /TILES_BUCKET/);
});

test("defaults: one render per tile per 1.5 s, 60 s of cache, 30 s for a missing tile", () => {
  const env = { TILES_BUCKET: "b" };
  assert.deepEqual(loadRendererConfig(env), { bucket: "b", minIntervalMs: 1500, budgetMs: 20_000, concurrency: 8, leaseMs: 25_000 });
  assert.deepEqual(loadReaderConfig(env), { bucket: "b", maxAgeSeconds: 60, missingMaxAgeSeconds: 30 });
});

test("values are taken from the environment and bounds are enforced", () => {
  const env = { TILES_BUCKET: "b", RENDER_MIN_INTERVAL_MS: "0", RENDER_CONCURRENCY: "2", TILE_MAX_AGE_SECONDS: "120" };
  assert.equal(loadRendererConfig(env).minIntervalMs, 0);
  assert.equal(loadRendererConfig(env).concurrency, 2);
  assert.equal(loadReaderConfig(env).maxAgeSeconds, 120);
  assert.throws(() => loadRendererConfig({ ...env, RENDER_CONCURRENCY: "0" }), /RENDER_CONCURRENCY/);
  assert.throws(() => loadRendererConfig({ ...env, RENDER_BUDGET_MS: "abc" }), /RENDER_BUDGET_MS/);
  assert.throws(() => loadReaderConfig({ ...env, TILE_MAX_AGE_SECONDS: "-1" }), /TILE_MAX_AGE_SECONDS/);
});
