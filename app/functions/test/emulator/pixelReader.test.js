// GET /pixels/{x}/{y} against the Firestore emulator, after a real draw.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createDrawStore } from "../../src/draw/store.js";
import { readPixel } from "../../src/pixels/pixelReader.js";
import { FieldValue } from "@google-cloud/firestore";
import { emulatorDb, emulatorOnly, resetEmulator } from "./helpers.js";

const DB = "pixels";

beforeEach(async () => {
  if (!emulatorOnly.skip) await resetEmulator(DB);
});

test("a pixel written by the draw worker is readable, then hidden by a clear", emulatorOnly, async () => {
  const db = emulatorDb(DB);
  await createDrawStore(db, { defaultLimit: 20, windowMs: 60_000 }).applyBatch({
    batchId: "b1",
    user: { id: "123456789012345678", name: "alice" },
    source: "web",
    pixels: [{ x: 42, y: 43, color: 0xabcdef }],
  });
  const pixel = await readPixel(db, 42, 43);
  assert.deepEqual({ ...pixel, ts: typeof pixel.ts }, { x: 42, y: 43, color: 0xabcdef, author: "123456789012345678", authorName: "alice", ts: "number" });
  assert.equal(await readPixel(db, 1, 1), null);

  await db.doc("session/state").set({ clearedAt: FieldValue.serverTimestamp() }, { merge: true });
  assert.equal(await readPixel(db, 42, 43), null);
});
