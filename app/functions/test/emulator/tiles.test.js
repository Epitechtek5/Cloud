// The Firestore side of the tiles against the emulator: the delta query of a
// tile (what the renderer and /get read) and the coalescing transactions.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { FieldValue, Timestamp } from "@google-cloud/firestore";
import { createDrawStore } from "../../src/draw/store.js";
import { createTileBucket } from "../../src/tiles/bucket.js";
import { currentTile, readTilePixels } from "../../src/tiles/current.js";
import { colorAt, pixelOffset } from "../../src/tiles/raster.js";
import { renderTile } from "../../src/tiles/renderer.js";
import { createTileState } from "../../src/tiles/state.js";
import { readSession } from "../../src/lib/canvas.js";
import { fakeStorageBucket } from "../tiles/helpers.js";
import { emulatorDb, emulatorOnly, resetEmulator } from "./helpers.js";

const DB = "tiles";
const USER = { id: "123456789012345678", name: "alice" };

beforeEach(async () => {
  if (!emulatorOnly.skip) await resetEmulator(DB);
});

async function draw(db, batchId, pixels) {
  await createDrawStore(db, { defaultLimit: 1000, windowMs: 60_000 }).applyBatch({ batchId, user: USER, source: "web", pixels });
}

test("the delta query returns the pixels of one tile newer than a time, oldest first, without the cleared ones", async () => {
  const db = emulatorDb(DB);
  await draw(db, "b1", [{ x: 1, y: 1, color: 0xff0000 }, { x: 300, y: 1, color: 0x00ff00 }]);
  const first = await readTilePixels(db, { tx: 0, ty: 0, sinceMs: 0, clearedAt: 0 });
  assert.deepEqual(first.map(({ x, y, c }) => ({ x, y, c })), [{ x: 1, y: 1, c: 0xff0000 }]);
  assert.ok(Number.isInteger(first[0].t), "t is whole milliseconds");

  await draw(db, "b2", [{ x: 2, y: 2, color: 0x0000ff }]);
  const since = await readTilePixels(db, { tx: 0, ty: 0, sinceMs: first[0].t, clearedAt: 0 });
  assert.ok(since.some((p) => p.x === 2), "the newer pixel is there");
  assert.ok(since.every((p) => p.t >= first[0].t));

  const cleared = await readTilePixels(db, { tx: 0, ty: 0, sinceMs: 0, clearedAt: since.at(-1).t });
  assert.deepEqual(cleared, [], "everything is at or before the clear");
});

test("render a tile from Firestore, repaint, clear: the raster follows", async () => {
  const db = emulatorDb(DB);
  const storage = fakeStorageBucket();
  const deps = { bucket: createTileBucket(storage), readSession: () => readSession(db), readPixels: (q) => readTilePixels(db, q) };

  await draw(db, "b1", [{ x: 10, y: 10, color: 0xff0000 }]);
  assert.equal(await renderTile(deps, 0, 0), "written");
  await draw(db, "b2", [{ x: 10, y: 10, color: 0x0000ff }, { x: 11, y: 10, color: 0x00ff00 }]);
  assert.equal(await renderTile(deps, 0, 0), "written");
  const tile = await currentTile({ ...deps, tx: 0, ty: 0, clearedAt: 0 });
  assert.equal(tile.upToDate, true);
  assert.equal(colorAt(tile.rgba, pixelOffset(10, 10)), 0x0000ff);
  assert.equal(colorAt(tile.rgba, pixelOffset(11, 10)), 0x00ff00);

  await db.doc("session/state").set({ clearedAt: FieldValue.serverTimestamp() }, { merge: true });
  assert.equal(await renderTile(deps, 0, 0), "deleted");
  assert.equal(storage.objects.size, 0);
});

test("the coalescing transactions elect one leader among concurrent messages", async () => {
  const db = emulatorDb(DB);
  // A long lease: 8 contending transactions can be retried for seconds on a busy emulator, and
  // a lease that expires meanwhile rightly elects a second leader (seen in CI with 5 s).
  const state = createTileState(db, { leaseMs: 60_000 });
  const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => state.touch("0_0", `owner-${i}`)));
  const leaders = claims.filter((c) => c.leader);
  assert.equal(leaders.length, 1);
  const owner = `owner-${claims.indexOf(leaders[0])}`;

  const checkpoint = await state.checkpoint("0_0", owner, leaders[0].seq);
  assert.equal(checkpoint.done, false, "the others counted meanwhile");
  assert.equal(checkpoint.seq, 8);
  assert.deepEqual(await state.checkpoint("0_0", owner, 8), { done: true });
  assert.equal((await db.doc("tileState/0_0").get()).data().renderedSeq, 8);
  assert.ok(Timestamp);
});
