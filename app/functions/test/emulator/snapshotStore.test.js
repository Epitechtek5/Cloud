// Snapshot worker's Firestore read against the emulator.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "@google-cloud/firestore";
import { readVisiblePixels } from "../../src/snapshot/store.js";
import { emulatorDb, emulatorOnly, resetEmulator } from "./helpers.js";

const DB = "snapshots";

beforeEach(async () => {
  if (!emulatorOnly.skip) await resetEmulator(DB);
});

test("reads every visible pixel, skips the cleared ones, stops at maxPixels", emulatorOnly, async () => {
  const db = emulatorDb(DB);
  const write = (x, t) => db.doc(`pixels/${x}_0`).set({ x, y: 0, tile: "0_0", c: x, a: "1", an: "a", t: Timestamp.fromMillis(t) });
  await Promise.all([write(1, 1000), write(2, 3000), write(3, 4000), write(4, 5000)]);
  await db.doc("session/state").set({ clearedAt: Timestamp.fromMillis(2000) });

  const all = await readVisiblePixels(db, { maxPixels: 10, maxReads: 10, budgetMs: 60_000 });
  assert.equal(all.truncated, false);
  assert.deepEqual(all.pixels.map((p) => [p.x, p.c, p.t]).sort(), [[2, 2, 3000], [3, 3, 4000], [4, 4, 5000]]);

  const capped = await readVisiblePixels(db, { maxPixels: 2, maxReads: 10, budgetMs: 60_000 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.pixels.length, 2);
});

test("stops after maxReads documents, erased ones included", emulatorOnly, async () => {
  const db = emulatorDb(DB);
  const write = (x, t) => db.doc(`pixels/${x}_0`).set({ x, y: 0, tile: "0_0", c: x, a: "1", an: "a", t: Timestamp.fromMillis(t) });
  await Promise.all([write(1, 1000), write(2, 1000), write(3, 4000), write(4, 5000)]);
  await db.doc("session/state").set({ clearedAt: Timestamp.fromMillis(2000) });
  // Documents stream in id order: 1_0 and 2_0 (erased) use up the reads.
  const bounded = await readVisiblePixels(db, { maxPixels: 10, maxReads: 2, budgetMs: 60_000 });
  assert.equal(bounded.truncated, true);
  assert.deepEqual(bounded.pixels, []);
});

test("a collection of exactly maxReads documents is not truncated", emulatorOnly, async () => {
  const db = emulatorDb(DB);
  const write = (x, t) => db.doc(`pixels/${x}_0`).set({ x, y: 0, tile: "0_0", c: x, a: "1", an: "a", t: Timestamp.fromMillis(t) });
  await Promise.all([write(1, 3000), write(2, 4000)]);
  await db.doc("session/state").set({ clearedAt: Timestamp.fromMillis(2000) });
  const exact = await readVisiblePixels(db, { maxPixels: 10, maxReads: 2, budgetMs: 60_000 });
  assert.equal(exact.truncated, false);
  assert.equal(exact.pixels.length, 2);
});

test("stops reading once the time budget is spent, whatever the throughput", emulatorOnly, async () => {
  const db = emulatorDb(DB);
  const write = (x, t) => db.doc(`pixels/${x}_0`).set({ x, y: 0, tile: "0_0", c: x, a: "1", an: "a", t: Timestamp.fromMillis(t) });
  await Promise.all([write(1, 3000), write(2, 4000), write(3, 5000), write(4, 6000)]);
  await db.doc("session/state").set({ clearedAt: Timestamp.fromMillis(2000) });
  // A slow stream: every call to the clock moves it 1 s forward.
  let clock = 0;
  const now = () => (clock += 1000);
  const slow = await readVisiblePixels(db, { maxPixels: 10, maxReads: 10, budgetMs: 2500, now });
  assert.equal(slow.truncated, true);
  assert.equal(slow.pixels.length, 2);
});
