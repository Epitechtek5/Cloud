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

  const all = await readVisiblePixels(db, { maxPixels: 10 });
  assert.equal(all.truncated, false);
  assert.deepEqual(all.pixels.map((p) => [p.x, p.c, p.t]).sort(), [[2, 2, 3000], [3, 3, 4000], [4, 4, 5000]]);

  const capped = await readVisiblePixels(db, { maxPixels: 2 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.pixels.length, 2);
});
