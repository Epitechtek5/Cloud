import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../../src/lib/logger.js";
import { createTileBucket } from "../../src/tiles/bucket.js";
import { cacheClearedAt, createTileReader } from "../../src/tiles/reader.js";
import { applyPixels, emptyRaster } from "../../src/tiles/raster.js";
import { captureLogs } from "../lib/helpers.js";
import { response } from "../discord/helpers.js";
import { fakeStorageBucket } from "./helpers.js";

const config = { maxAgeSeconds: 60, missingMaxAgeSeconds: 30 };

async function setup({ clearedAt = 0, origins } = {}) {
  const storage = fakeStorageBucket();
  const out = captureLogs();
  const state = { clearedAt };
  const reader = createTileReader({
    getBucket: async () => storage,
    getClearedAt: async () => {
      if (state.clearedAtFails) throw new Error("firestore down");
      return state.clearedAt;
    },
    config,
    origins,
    logger: createLogger({}, { write: out.write }),
  });
  const get = async (path, { method = "GET", headers = {} } = {}) => {
    const res = response();
    res.end = () => res;
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    await reader({ method, path, url: path, headers: lower, get: (n) => lower[n.toLowerCase()] }, res);
    return res;
  };
  const put = async (tx, ty, version, pixels = [{ x: tx * 256, y: ty * 256, c: 0x336699 }]) => {
    const rgba = emptyRaster();
    applyPixels(rgba, pixels);
    await createTileBucket(storage).write(tx, ty, rgba, version);
  };
  return { get, put, state, storage, logs: out.lines };
}

test("serves the raster with exactly what the front reads: PNG, X-Tile-Version, Cache-Control", async () => {
  const t = await setup();
  await t.put(3, 4, 1_700_000_000_123);
  const res = await t.get("/tiles/3/4.png");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "image/png");
  assert.equal(res.headers["X-Tile-Version"], "1700000000123");
  assert.equal(res.headers["Cache-Control"], "public, max-age=60");
  assert.equal(res.headers["Access-Control-Expose-Headers"], "X-Tile-Version");
  assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
  assert.deepEqual([...res.body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test("a tile never painted is a 404 with version 0, cached briefly", async () => {
  const t = await setup();
  const res = await t.get("/tiles/0/0.png");
  assert.equal(res.statusCode, 404);
  assert.equal(res.headers["X-Tile-Version"], "0");
  assert.equal(res.headers["Cache-Control"], "public, max-age=30");
});

test("a raster rendered before the last clear is never served, swept or not", async () => {
  const t = await setup({ clearedAt: 5000 });
  await t.put(0, 0, 4000);
  await t.put(0, 1, 5000); // the clear's own millisecond: erased as well
  await t.put(0, 2, 5001);
  assert.equal((await t.get("/tiles/0/0.png")).statusCode, 404);
  assert.equal((await t.get("/tiles/0/1.png")).statusCode, 404);
  const fresh = await t.get("/tiles/0/2.png");
  assert.equal(fresh.statusCode, 200);
  assert.equal(fresh.headers["X-Tile-Version"], "5001");
  assert.equal((await t.get("/tiles/0/0.png")).headers["X-Tile-Version"], "0");
});

test("paths outside the tile grid or of another shape are 404, never a storage read", async () => {
  const t = await setup();
  for (const path of ["/tiles/391/0.png", "/tiles/0/999.png", "/tiles/a/b.png", "/tiles/1/2.jpg", "/other", "/tiles/1/2.png/extra"]) {
    const res = await t.get(path);
    assert.equal(res.statusCode, 404, path);
  }
  assert.equal(t.storage.calls.download, 0);
  // The query string does not matter, and the gateway may prefix the path.
  await t.put(1, 2, 10);
  assert.equal((await t.get("/tiles/1/2.png?v=3")).statusCode, 200);
  assert.equal((await t.get("/api/tiles/1/2.png")).statusCode, 200);
});

test("only GET and HEAD read; OPTIONS answers the preflight; the rest is 405", async () => {
  const t = await setup();
  await t.put(0, 0, 10);
  assert.equal((await t.get("/tiles/0/0.png", { method: "HEAD" })).statusCode, 200);
  const options = await t.get("/tiles/0/0.png", { method: "OPTIONS" });
  assert.equal(options.statusCode, 204);
  assert.equal(options.headers["Access-Control-Allow-Methods"], "GET, HEAD");
  const post = await t.get("/tiles/0/0.png", { method: "POST" });
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.Allow, "GET, HEAD, OPTIONS");
});

test("CORS only for the listed origins", async () => {
  const t = await setup({ origins: new Set(["https://front.test"]) });
  await t.put(0, 0, 10);
  const ok = await t.get("/tiles/0/0.png", { headers: { Origin: "https://front.test" } });
  assert.equal(ok.headers["Access-Control-Allow-Origin"], "https://front.test");
  assert.equal(ok.headers.Vary, "Origin");
  const other = await t.get("/tiles/0/0.png", { headers: { Origin: "https://evil.test" } });
  assert.equal(other.headers["Access-Control-Allow-Origin"], undefined);
});

test("a storage failure is a 503 that is never cached", async () => {
  const t = await setup();
  t.storage.file = () => ({ download: async () => Promise.reject(Object.assign(new Error("boom"), { code: 500 })) });
  const res = await t.get("/tiles/0/0.png");
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.ok(t.logs.some((l) => l.message === "cannot read the tile"));
});

test("without the grid generation the reader fails closed rather than risk serving an erased grid", async () => {
  const t = await setup();
  await t.put(0, 0, 10);
  t.state.clearedAtFails = true;
  const res = await t.get("/tiles/0/0.png");
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("a raster without a valid version is never served", async () => {
  const t = await setup();
  await t.storage.file("0/0.png").save(Buffer.from("not a png"), { metadata: {} });
  const res = await t.get("/tiles/0/0.png");
  assert.equal(res.statusCode, 503);
  assert.ok(t.logs.some((l) => l.message === "tile without a valid version"));
});

test("the grid generation is cached briefly per instance, and a failed read is not cached", async () => {
  let now = 0;
  let calls = 0;
  let fail = true;
  const read = cacheClearedAt(async () => {
    calls++;
    if (fail) throw new Error("down");
    return calls;
  }, { ttlMs: 1000, now: () => now });
  await assert.rejects(read(), /down/);
  fail = false;
  assert.equal(await read(), 2);
  now = 999;
  assert.equal(await read(), 2, "cached");
  now = 1001;
  assert.equal(await read(), 3, "refreshed after the ttl");
});
