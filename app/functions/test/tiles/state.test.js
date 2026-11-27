import { test } from "node:test";
import assert from "node:assert/strict";
import { createTileState, TILE_STATE_COLLECTION } from "../../src/tiles/state.js";
import { fakeStateDb } from "./helpers.js";

const doc = (db, tile) => db.docs.get(`${TILE_STATE_COLLECTION}/${tile}`);

function setup({ leaseMs = 1000 } = {}) {
  const clock = { now: 10_000 };
  const db = fakeStateDb();
  return { db, clock, state: createTileState(db, { leaseMs, now: () => clock.now }) };
}

test("the first message of a quiet tile leads it, and counts itself", async () => {
  const { db, state } = setup();
  assert.deepEqual(await state.touch("0_0", "a"), { leader: true, seq: 1 });
  assert.equal(doc(db, "0_0").owner, "a");
  assert.equal(doc(db, "0_0").leaseUntil, 11_000);
});

test("while a leader holds the tile, other messages only mark it dirty", async () => {
  const { db, state } = setup();
  await state.touch("0_0", "a");
  assert.deepEqual(await state.touch("0_0", "b"), { leader: false, seq: 2 });
  assert.deepEqual(await state.touch("0_0", "c"), { leader: false, seq: 3 });
  assert.equal(doc(db, "0_0").owner, "a", "the leader is unchanged");
});

test("two instances claiming at the same time: exactly one leads", async () => {
  const { state } = setup();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => state.touch("0_0", `o${i}`)));
  assert.equal(results.filter((r) => r.leader).length, 1);
  assert.deepEqual(results.map((r) => r.seq).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
});

test("each tile has its own leader", async () => {
  const { state } = setup();
  assert.equal((await state.touch("0_0", "a")).leader, true);
  assert.equal((await state.touch("0_1", "b")).leader, true);
});

test("the leader releases the tile when nothing arrived since what it rendered", async () => {
  const { db, state } = setup();
  const { seq } = await state.touch("0_0", "a");
  assert.deepEqual(await state.checkpoint("0_0", "a", seq), { done: true });
  assert.equal(doc(db, "0_0").owner, null);
  assert.equal(doc(db, "0_0").renderedSeq, seq);
  // The next message leads again.
  assert.equal((await state.touch("0_0", "b")).leader, true);
});

test("when messages arrived meanwhile, the checkpoint returns the new target and renews the lease", async () => {
  const { db, clock, state } = setup();
  const { seq } = await state.touch("0_0", "a");
  await state.touch("0_0", "b");
  await state.touch("0_0", "c");
  clock.now += 600;
  assert.deepEqual(await state.checkpoint("0_0", "a", seq), { done: false, seq: 3 });
  assert.equal(doc(db, "0_0").leaseUntil, 11_600);
  assert.deepEqual(await state.checkpoint("0_0", "a", 3), { done: true });
});

test("a leader that died is replaced once its lease expired, and the old one notices", async () => {
  const { clock, state } = setup({ leaseMs: 1000 });
  await state.touch("0_0", "dead");
  clock.now += 500;
  assert.equal((await state.touch("0_0", "b")).leader, false, "still within the lease");
  clock.now += 600;
  assert.deepEqual(await state.touch("0_0", "c"), { leader: true, seq: 3 });
  assert.deepEqual(await state.checkpoint("0_0", "dead", 1), { done: false, lost: true });
});

test("release hands the tile back, but only for its owner", async () => {
  const { db, state } = setup();
  await state.touch("0_0", "a");
  await state.release("0_0", "someone-else");
  assert.equal(doc(db, "0_0").owner, "a");
  await state.release("0_0", "a");
  assert.equal(doc(db, "0_0").owner, null);
  assert.equal((await state.touch("0_0", "b")).leader, true);
  await state.release("9_9", "a"); // unknown tile: nothing to do
  assert.equal(doc(db, "9_9"), undefined);
});

test("a checkpoint on a tile without state loses the lease", async () => {
  const { state } = setup();
  assert.deepEqual(await state.checkpoint("5_5", "a", 1), { done: false, lost: true });
});
