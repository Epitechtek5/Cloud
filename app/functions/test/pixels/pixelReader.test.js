import { test } from "node:test";
import assert from "node:assert/strict";
import { createPixelReader } from "../../src/pixels/pixelReader.js";
import { createLogger } from "../../src/lib/logger.js";
import { apiRequest, apiResponse } from "./helpers.js";

const ts = (ms) => ({ toMillis: () => ms });

/** Just what readPixel uses: doc(...).get() on pixels and session/state. */
function fakeDb({ pixels = {}, session, fail } = {}) {
  const snap = (data) => ({ exists: data !== undefined, data: () => data });
  return {
    collection: () => ({ doc: (id) => ({ get: async () => (fail ? Promise.reject(fail) : snap(pixels[id])) }) }),
    doc: () => ({ get: async () => snap(session) }),
  };
}

function setup(db) {
  const reader = createPixelReader({ getDb: async () => db, origins: new Set(["https://app.test"]), logger: createLogger({}, { write: () => {} }) });
  return async (req) => {
    const res = apiResponse();
    await reader(req, res);
    return res;
  };
}

const painted = { "10_20": { x: 10, y: 20, c: 0xff0000, a: "123456789012345678", an: "alice", t: ts(5000) } };

test("returns colour, author and timestamp of a painted pixel", async () => {
  const call = setup(fakeDb({ pixels: painted }));
  const res = await call(apiRequest({ method: "GET", path: "/pixels/10/20" }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { x: 10, y: 20, color: 0xff0000, author: "123456789012345678", authorName: "alice", ts: 5000 });
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("404 when never painted or erased by /admin clear", async () => {
  assert.equal((await setup(fakeDb())(apiRequest({ method: "GET", path: "/pixels/1/1" }))).statusCode, 404);
  const cleared = setup(fakeDb({ pixels: painted, session: { clearedAt: ts(6000) } }));
  assert.equal((await cleared(apiRequest({ method: "GET", path: "/pixels/10/20" }))).statusCode, 404);
  const after = setup(fakeDb({ pixels: painted, session: { clearedAt: ts(4000) } }));
  assert.equal((await after(apiRequest({ method: "GET", path: "/pixels/10/20" }))).statusCode, 200);
});

test("400 outside the grid or on a malformed path, 401 without user, 405, 503", async () => {
  const call = setup(fakeDb({ pixels: painted }));
  for (const path of ["/pixels/100000/1", "/pixels/a/1", "/pixels/1", "/other"])
    assert.equal((await call(apiRequest({ method: "GET", path }))).statusCode, 400, path);
  assert.equal((await call(apiRequest({ method: "GET", path: "/pixels/10/20", user: false }))).statusCode, 401);
  assert.equal((await call(apiRequest({ method: "POST", path: "/pixels/10/20" }))).statusCode, 405);
  assert.equal((await call(apiRequest({ method: "OPTIONS", path: "/pixels/10/20", user: false }))).statusCode, 204);
  const down = setup(fakeDb({ fail: new Error("unavailable") }));
  assert.equal((await down(apiRequest({ method: "GET", path: "/pixels/10/20" }))).statusCode, 503);
});

test("authorName falls back to the author id", async () => {
  const call = setup(fakeDb({ pixels: { "1_2": { x: 1, y: 2, c: 1, a: "123456789012345678", t: ts(1) } } }));
  assert.equal((await call(apiRequest({ method: "GET", path: "/pixels/1/2/" }))).body.authorName, "123456789012345678");
});
