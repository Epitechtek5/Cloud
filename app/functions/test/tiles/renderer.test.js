import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../../src/lib/logger.js";
import { createTileBucket } from "../../src/tiles/bucket.js";
import { colorAt, pixelOffset } from "../../src/tiles/raster.js";
import { createTileRenderer, renderTile, RenderBudgetError, syncTile } from "../../src/tiles/renderer.js";
import { createTileState } from "../../src/tiles/state.js";
import { captureLogs } from "../lib/helpers.js";
import { pushRequest } from "../commands/helpers.js";
import { response } from "../discord/helpers.js";
import { fakePixels, fakeStateDb, fakeStorageBucket } from "./helpers.js";

/** Everything a tile renderer needs, in memory. */
function world({ pixels = [], clearedAt = 0, leaseMs = 25_000 } = {}) {
  const storage = fakeStorageBucket();
  const px = fakePixels(pixels);
  const session = { clearedAt };
  const db = fakeStateDb();
  const clock = { now: 1_000_000 };
  return {
    storage,
    px,
    session,
    db,
    clock,
    deps: {
      state: createTileState(db, { leaseMs, now: () => clock.now }),
      bucket: createTileBucket(storage),
      readSession: async () => ({ clearedAt: session.clearedAt }),
      readPixels: px.read,
    },
  };
}

const COLOR = 0xff8800;

// --- one render --------------------------------------------------------------

test("a render writes the raster with the version of the newest pixel, then finds nothing more to do", async () => {
  const w = world({ pixels: [{ x: 3, y: 4, c: COLOR, t: 5_000.9 | 0 }, { x: 4, y: 4, c: 1, t: 7_000 }] });
  assert.equal(await renderTile(w.deps, 0, 0), "written");
  const tile = await w.deps.bucket.read(0, 0);
  assert.equal(tile.version, 7_000);
  assert.equal(colorAt(tile.rgba, pixelOffset(3, 4)), COLOR);
  assert.equal(w.storage.objects.get("tiles/0/0.png").meta.metadata["tile-version"], "7000");

  assert.equal(await renderTile(w.deps, 0, 0), "unchanged");
  assert.equal(w.storage.calls.save, 1);
});

test("a render that only reads the newest pixel again does not rewrite the raster", async () => {
  // Review of #143 (M1): `t > version` returns the newest pixel at every read (version rounded down to the ms).
  const w = world({ pixels: [{ x: 3, y: 4, c: COLOR, t: 5_000 }] });
  assert.equal(await renderTile(w.deps, 0, 0), "written");
  w.deps.readPixels = async () => [{ x: 3, y: 4, c: COLOR, t: 5_000 }];
  assert.equal(await renderTile(w.deps, 0, 0), "unchanged");
  assert.equal(w.storage.calls.save, 1);
});

test("a render of a tile with nothing painted writes nothing", async () => {
  const w = world();
  assert.equal(await renderTile(w.deps, 4, 4), "unchanged");
  assert.equal(w.storage.objects.size, 0);
});

test("after a clear, a raster with nothing left is deleted, and one repainted is rewritten from the clear", async () => {
  const w = world({ pixels: [{ x: 1, y: 1, c: 1, t: 1000 }, { x: 256, y: 1, c: 2, t: 1000 }] });
  await renderTile(w.deps, 0, 0);
  await renderTile(w.deps, 1, 0);
  w.session.clearedAt = 2000;
  w.px.paint({ x: 260, y: 1, c: 3, t: 3000 });

  assert.equal(await renderTile(w.deps, 0, 0), "deleted");
  assert.equal(w.storage.objects.has("tiles/0/0.png"), false);
  assert.equal(await renderTile(w.deps, 1, 0), "written");
  const tile = await w.deps.bucket.read(1, 0);
  assert.equal(tile.version, 3000);
  assert.equal(colorAt(tile.rgba, pixelOffset(256, 1)), -1, "the erased pixel is gone");
  assert.equal(colorAt(tile.rgba, pixelOffset(260, 1)), 3);
});

test("a write lost to a concurrent renderer is redone from the winner's raster, up to a limit", async () => {
  const w = world({ pixels: [{ x: 1, y: 1, c: 1, t: 1000 }] });
  const realWrite = w.deps.bucket.write;
  let sabotage = 2;
  // Someone else renders in between: our write sees a newer generation.
  w.deps.bucket.write = async (...args) => {
    if (sabotage-- > 0) await realWrite(0, 0, new Uint8Array(256 * 256 * 4), 1);
    return realWrite(...args);
  };
  assert.equal(await renderTile(w.deps, 0, 0), "written");
  assert.equal((await w.deps.bucket.read(0, 0)).version, 1000);

  sabotage = Infinity;
  w.deps.bucket.write = async (...args) => {
    await realWrite(0, 0, new Uint8Array(256 * 256 * 4), 1);
    return realWrite(...args);
  };
  w.px.paint({ x: 2, y: 2, c: 2, t: 9000 });
  await assert.rejects(renderTile(w.deps, 0, 0), /changed by someone else/);
});

test("an /admin clear committed during a render is never baked into the raster", async () => {
  // Review of #143 (I1): the session is read before the clear, the pixels after it
  // and after a new pixel. Without a second look at the session, the raster would
  // mix erased pixels with a version newer than the clear, and keep them for good.
  const w = world({ pixels: [{ x: 1, y: 1, c: 1, t: 1000 }] });
  await renderTile(w.deps, 0, 0);
  w.px.paint({ x: 2, y: 2, c: 2, t: 1500 }); // painted before the clear
  let raced = false;
  w.deps.readPixels = async (query) => {
    if (!raced) {
      raced = true;
      w.session.clearedAt = 2000;
      w.px.paint({ x: 3, y: 3, c: 3, t: 2500 }); // painted after the clear
    }
    return w.px.read(query);
  };

  assert.equal(await renderTile(w.deps, 0, 0), "written");
  const tile = await w.deps.bucket.read(0, 0);
  assert.equal(tile.version, 2500);
  assert.equal(colorAt(tile.rgba, pixelOffset(1, 1)), -1, "erased before the clear");
  assert.equal(colorAt(tile.rgba, pixelOffset(2, 2)), -1, "erased before the clear");
  assert.equal(colorAt(tile.rgba, pixelOffset(3, 3)), 3);
});

// --- the leader loop ---------------------------------------------------------

const options = (w, extra = {}) => ({ minIntervalMs: 100, deadline: w.clock.now + 60_000, now: () => w.clock.now, sleep: async (ms) => void (w.clock.now += ms), ...extra });

test("a follower renders nothing: the leader of the tile will", async () => {
  const w = world({ pixels: [{ x: 1, y: 1, c: 1, t: 1000 }] });
  await w.deps.state.touch("0_0", "leader");
  assert.deepEqual(await syncTile(w.deps, "0_0", options(w)), { led: false, renders: 0 });
  assert.equal(w.storage.objects.size, 0);
});

test("a leader renders again, no more often than the minimum interval, while messages keep arriving", async () => {
  const w = world({ pixels: [{ x: 1, y: 1, c: 1, t: 1000 }] });
  const sleeps = [];
  // Messages arrive while the leader renders: two more, then none.
  let extra = 2;
  const realRead = w.deps.readPixels;
  w.deps.readPixels = async (q) => {
    const result = await realRead(q);
    if (extra-- > 0) {
      w.px.paint({ x: 10 + extra, y: 1, c: 5, t: 2000 + extra });
      await w.deps.state.touch("0_0", `follower-${extra}`);
    }
    return result;
  };
  const result = await syncTile(w.deps, "0_0", options(w, { sleep: async (ms) => (sleeps.push(ms), void (w.clock.now += ms)) }));
  assert.equal(result.led, true);
  assert.equal(result.renders, 3, "initial render, then one per wave of messages");
  assert.ok(sleeps.every((ms) => ms > 0 && ms <= 100), "waits to respect the interval");
  assert.equal((await w.deps.bucket.read(0, 0)).version, 2001);
  assert.equal(w.db.docs.get("tileState/0_0").owner, null, "released at the end");
});

test("a leader killed without giving the tile back is replaced by the redelivery of its own message", async () => {
  // Review of #143 (M4): with a random owner per delivery, the redelivery found the dead leader's lease
  // (25 s) still alive when it came back sooner, took the tile for a follower's and acked: no render until
  // the next draw on that tile.
  const w = world({ pixels: [{ x: 1, y: 1, c: 1, t: 1000 }] });
  await w.deps.state.touch("0_0", "msg-7"); // the leader of message msg-7 was killed here: lease taken, nothing rendered
  assert.equal(w.storage.objects.size, 0);

  // Another message in the meantime has to wait for the lease: not a leader.
  assert.deepEqual(await syncTile(w.deps, "0_0", options(w, { owner: "msg-8" })), { led: false, renders: 0 });
  // The redelivery of msg-7 takes over at once and renders.
  assert.deepEqual(await syncTile(w.deps, "0_0", options(w, { owner: "msg-7" })), { led: true, renders: 1 });
  assert.ok(w.storage.objects.has("tiles/0/0.png"));
  assert.equal(w.db.docs.get("tileState/0_0").owner, null);
});

test("a leader whose lease was taken over stops quietly", async () => {
  const w = world({ pixels: [{ x: 1, y: 1, c: 1, t: 1000 }], leaseMs: 1000 });
  const realRead = w.deps.readPixels;
  w.deps.readPixels = async (q) => {
    w.clock.now += 5000; // very slow render: the lease expires and another instance leads
    await w.deps.state.touch("0_0", "usurper");
    return realRead(q);
  };
  assert.deepEqual(await syncTile(w.deps, "0_0", options(w)), { led: true, renders: 1 });
  assert.equal(w.db.docs.get("tileState/0_0").owner, "usurper");
});

test("out of time budget the leader gives the tile back and fails, so that the message is retried", async () => {
  const w = world({ pixels: [{ x: 1, y: 1, c: 1, t: 1000 }] });
  const realRead = w.deps.readPixels;
  w.deps.readPixels = async (q) => {
    await w.deps.state.touch("0_0", "follower"); // always one more message
    return realRead(q);
  };
  await assert.rejects(syncTile(w.deps, "0_0", options(w, { deadline: w.clock.now + 50 })), RenderBudgetError);
  assert.equal(w.db.docs.get("tileState/0_0").owner, null);
  assert.equal((await w.deps.state.touch("0_0", "retry")).leader, true);
});

test("a render failure gives the tile back too", async () => {
  const w = world();
  w.deps.readPixels = async () => Promise.reject(new Error("firestore down"));
  await assert.rejects(syncTile(w.deps, "0_0", options(w)), /firestore down/);
  assert.equal(w.db.docs.get("tileState/0_0").owner, null);
  // Even if giving back fails, the original error is the one reported.
  w.deps.state.release = async () => Promise.reject(new Error("also down"));
  await assert.rejects(syncTile(w.deps, "0_1", options(w)), /firestore down/);
});

// --- the worker --------------------------------------------------------------

function worker(w, { config = {}, extra = {} } = {}) {
  const out = captureLogs();
  const handler = createTileRenderer({
    getDeps: async () => w.deps,
    config: { minIntervalMs: 1, budgetMs: 10_000, concurrency: 4, ...config },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    logger: createLogger({}, { write: out.write }),
    ...extra,
  });
  let delivered = 0;
  // Each message has its own Pub/Sub messageId (the leader of a tile is named after it); a redelivery keeps it.
  const send = async (payload, eventType = "pixel.processed", { messageId = `msg-${++delivered}` } = {}) => {
    const res = response();
    res.end = () => res;
    const req = pushRequest(eventType, payload);
    req.body.message.messageId = messageId;
    await handler(req, res);
    return res.statusCode;
  };
  return { send, logs: out.lines };
}

const processed = (batchId, pixels, extra = {}) => ({
  batchId,
  userId: "123456789012345678",
  pixels: pixels.map(({ x, y, c }) => ({ x, y, color: c })),
  ...extra,
});

test("a pixel.processed batch gets the raster of every tile it touches, then 204", async () => {
  const w = world({ pixels: [{ x: 1, y: 1, c: 1, t: 1000 }, { x: 300, y: 1, c: 2, t: 1000 }, { x: 5, y: 600, c: 3, t: 1000 }] });
  const { send, logs } = worker(w);
  assert.equal(await send(processed("b1", w.px.docs)), 204);
  assert.deepEqual([...w.storage.objects.keys()].sort(), ["tiles/0/0.png", "tiles/0/2.png", "tiles/1/0.png"]);
  const line = logs.find((l) => l.message === "tiles synchronised");
  assert.deepEqual([line.tiles, line.led, line.renders, line.failed], [3, 3, 3, 0]);
});

test("a batch with no accepted pixel (all rejected) renders nothing", async () => {
  const w = world();
  const { send } = worker(w);
  assert.equal(await send({ batchId: "b2", userId: "123456789012345678", pixels: [], rejected: [{ x: 1, y: 1, reason: "paused" }] }), 204);
  assert.equal(w.db.docs.size, 0);
});

test("a burst of messages on one tile is coalesced: far fewer renders than messages, nothing lost", async () => {
  const w = world();
  const { send } = worker(w);
  const MESSAGES = 60;
  // Each message is published after its pixels were committed, like the draw worker does.
  const handled = [];
  for (let i = 0; i < MESSAGES; i++) {
    const pixel = { x: i, y: 7, c: 0x010000 + i, t: 10_000 + i };
    w.px.paint(pixel);
    handled.push(send(processed(`burst-${i}`, [pixel])));
    if (i % 10 === 9) await new Promise((resolve) => setTimeout(resolve, 3));
  }
  assert.deepEqual(await Promise.all(handled), new Array(MESSAGES).fill(204));

  assert.ok(w.storage.calls.save < MESSAGES / 3, `${w.storage.calls.save} renders for ${MESSAGES} messages`);
  const tile = await w.deps.bucket.read(0, 0);
  assert.equal(tile.version, 10_000 + MESSAGES - 1, "the newest pixel is in the raster");
  for (let i = 0; i < MESSAGES; i++) assert.equal(colorAt(tile.rgba, pixelOffset(i, 7)), 0x010000 + i);
  assert.equal(w.db.docs.get("tileState/0_0").owner, null, "released");
});

test("a failing tile fails the message (retried) after the others were rendered", async () => {
  const w = world({ pixels: [{ x: 1, y: 1, c: 1, t: 1000 }, { x: 300, y: 1, c: 2, t: 1000 }] });
  const read = w.deps.readPixels;
  w.deps.readPixels = async (q) => (q.tx === 1 ? Promise.reject(new Error("boom")) : read(q));
  const { send, logs } = worker(w);
  assert.equal(await send(processed("b3", w.px.docs)), 500);
  assert.ok(w.storage.objects.has("tiles/0/0.png"), "the healthy tile is rendered anyway");
  assert.equal(logs.find((l) => l.message === "tiles synchronised").failed, 1);
  assert.ok(logs.some((l) => l.message === "tile not rendered, the message will be retried"));
});

test("tiles left over when the time budget is spent are retried", async () => {
  const w = world({ pixels: [{ x: 1, y: 1, c: 1, t: 1000 }, { x: 300, y: 1, c: 2, t: 1000 }] });
  const { send } = worker(w, { config: { concurrency: 1 }, extra: { now: (() => { let t = 0; return () => (t += 6000); })() } });
  assert.equal(await send(processed("b4", w.px.docs)), 500);
});

test("/admin clear sweeps the rasters rendered before it and renders nothing else", async () => {
  const w = world({ pixels: [{ x: 1, y: 1, c: 1, t: 1000 }, { x: 300, y: 1, c: 2, t: 3000 }] });
  await renderTile(w.deps, 0, 0);
  await renderTile(w.deps, 1, 0);
  w.session.clearedAt = 2000;
  const { send, logs } = worker(w);
  assert.equal(await send({ batchId: "clear-1", userId: "123456789012345678", cleared: true, pixels: [] }), 204);
  assert.deepEqual([...w.storage.objects.keys()], ["tiles/1/0.png"], "the newer raster stays");
  assert.equal(logs.find((l) => l.message === "rasters erased after a clear").erased, 1);
});

test("the redelivery of a message whose leader died renders the tile it left behind", async () => {
  const w = world({ pixels: [{ x: 1, y: 1, c: 1, t: 1000 }] });
  await w.deps.state.touch("0_0", "msg-lost"); // killed instance of the first delivery
  const { send } = worker(w);
  assert.equal(await send(processed("b9", w.px.docs), "pixel.processed", { messageId: "msg-lost" }), 204);
  assert.ok(w.storage.objects.has("tiles/0/0.png"), "the redelivery took the lease of its own message");
});

test("a sweep out of time budget fails the message so that the retry continues it", async () => {
  const w = world({ pixels: [{ x: 1, y: 1, c: 1, t: 1000 }, { x: 300, y: 1, c: 2, t: 1000 }] });
  await renderTile(w.deps, 0, 0);
  await renderTile(w.deps, 1, 0);
  w.session.clearedAt = 2000;
  const { send, logs } = worker(w, { extra: { now: (() => { let t = 0; return () => (t += 6000); })() } });
  assert.equal(await send({ batchId: "clear-2", userId: "123456789012345678", cleared: true, pixels: [] }), 500);
  assert.equal(logs.find((l) => l.message === "rasters erased after a clear").complete, false);
});

test("refuses other event types and invalid messages without touching anything", async () => {
  const w = world();
  const { send } = worker(w);
  assert.equal(await send({}, "pixel.draw"), 400);
  assert.equal(await send({ batchId: "x" }), 400);
  assert.equal(w.db.docs.size, 0);
});
