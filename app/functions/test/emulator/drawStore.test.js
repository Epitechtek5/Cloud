// Draw worker against the Firestore emulator: the acceptance criteria of #65.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createDrawStore, USER_EVENT_TTL_MS } from "../../src/draw/store.js";
import { createDrawWorker } from "../../src/draw/worker.js";
import { createLogger } from "../../src/lib/logger.js";
import { response } from "../discord/helpers.js";
import { fakeDiscord, fakePublisher, pushRequest } from "../commands/helpers.js";
import { emulatorDb, emulatorOnly, resetEmulator } from "./helpers.js";

const DB = "draw";

const UID = "123456789012345678";
let clock = Date.UTC(2026, 10, 16, 12, 0, 0);

function setup() {
  const db = emulatorDb(DB);
  const store = createDrawStore(db, { defaultLimit: 20, windowMs: 60_000, now: () => clock });
  const { publisher, published } = fakePublisher();
  const worker = createDrawWorker({ getStore: async () => store, publisher, discord: fakeDiscord(), logger: createLogger({}, { write: () => {} }) });
  const send = async (payload) => {
    const res = response();
    res.end = () => res;
    await worker(pushRequest("pixel.draw", payload), res);
    return res.statusCode;
  };
  return { db, store, published, send };
}

const draw = (batchId, pixels, uid = UID, name = "alice") => ({ batchId, user: { id: uid, name }, source: "web", pixels });
const line = (n, y = 0) => Array.from({ length: n }, (_, i) => ({ x: i, y, color: 0xff0000 }));

beforeEach(async () => {
  clock = Date.UTC(2026, 10, 16, 12, 0, 0);
  if (!emulatorOnly.skip) await resetEmulator(DB);
});

test("21 pixels within a minute: 20 accepted, 1 rejected with a userEvents entry", emulatorOnly, async () => {
  const { db, send, published } = setup();
  assert.equal(await send(draw("b1", line(15))), 204);
  clock += 30_000;
  assert.equal(await send(draw("b2", line(6, 1))), 204);

  assert.equal((await db.collection("pixels").get()).size, 20);
  const user = (await db.doc(`users/${UID}`).get()).data();
  assert.deepEqual([user.used, user.limit], [20, 20]);
  const event = (await db.doc(`userEvents/${UID}_b2`).get()).data();
  assert.equal(event.uid, UID);
  assert.equal(event.type, "rejected");
  assert.equal(event.reason, "rate_limited");
  assert.deepEqual(event.pixels, [{ x: 5, y: 1, color: 0xff0000 }]);
  assert.equal(event.expireAt.toMillis(), clock + USER_EVENT_TTL_MS);
  assert.deepEqual(published[1].payload.rejected, [{ x: 5, y: 1, reason: "rate_limited" }]);

  // A new window one minute later.
  clock += 31_000;
  await send(draw("b3", line(3, 2)));
  assert.equal((await db.doc(`users/${UID}`).get()).data().used, 3);
});

test("pixel documents carry colour, author, tile and a server timestamp", emulatorOnly, async () => {
  const { db, send } = setup();
  await send(draw("b1", [{ x: 300, y: 513, color: 0x00ff00 }]));
  const doc = (await db.doc("pixels/300_513").get()).data();
  assert.deepEqual({ x: doc.x, y: doc.y, tile: doc.tile, c: doc.c, a: doc.a, an: doc.an }, { x: 300, y: 513, tile: "1_2", c: 0x00ff00, a: UID, an: "alice" });
  assert.ok(Math.abs(doc.t.toMillis() - Date.now()) < 60_000);
});

test("redelivering a batch does not double-count the quota", emulatorOnly, async () => {
  const { db, send, published } = setup();
  await send(draw("b1", line(10)));
  await send(draw("b1", line(10)));
  await Promise.all([send(draw("b1", line(10))), send(draw("b1", line(10)))]);
  assert.equal((await db.doc(`users/${UID}`).get()).data().used, 10);
  assert.equal((await db.doc(`processedBatches/${UID}_b1`).get()).data().outcome.accepted.length, 10);
  // The outcome is replayed each time, consumers dedupe on batchId.
  assert.ok(published.every((p) => p.payload.batchId === "b1" && p.payload.pixels.length === 10));
});

test("concurrent batches of one user never exceed the limit", emulatorOnly, async () => {
  const { db, send } = setup();
  await Promise.all(Array.from({ length: 5 }, (_, i) => send(draw(`c${i}`, line(8, i)))));
  assert.equal((await db.doc(`users/${UID}`).get()).data().used, 20);
  assert.equal((await db.collection("pixels").get()).size, 20);
});

test("two concurrent draws on the same pixel leave a consistent document", emulatorOnly, async () => {
  const { db, send } = setup();
  const other = "223456789012345678";
  await Promise.all([
    send(draw("p1", [{ x: 7, y: 7, color: 0x111111 }], UID, "alice")),
    send(draw("p2", [{ x: 7, y: 7, color: 0x222222 }], other, "bob")),
  ]);
  const doc = (await db.doc("pixels/7_7").get()).data();
  // Whole document from one writer: colour and author always match.
  assert.ok((doc.c === 0x111111 && doc.a === UID && doc.an === "alice") || (doc.c === 0x222222 && doc.a === other && doc.an === "bob"));
});

test("while paused every pixel is rejected (web and /draw), quota untouched", emulatorOnly, async () => {
  const { db, send } = setup();
  await db.doc("session/state").set({ paused: true });
  await send(draw("b1", line(4)));
  await send({ ...draw("b2", line(1)), source: "discord" });
  assert.equal((await db.collection("pixels").get()).size, 0);
  assert.equal((await db.doc(`users/${UID}`).get()).exists, false);
  assert.equal((await db.doc(`userEvents/${UID}_b1`).get()).data().reason, "paused");
  assert.equal((await db.doc(`userEvents/${UID}_b2`).get()).data().reason, "paused");
});

test("the /admin ratelimit override is applied", emulatorOnly, async () => {
  const { db, send } = setup();
  await db.doc(`users/${UID}`).set({ override: 2, limit: 2 });
  await send(draw("b1", line(5)));
  assert.equal((await db.collection("pixels").get()).size, 2);
  assert.deepEqual((await db.doc(`userEvents/${UID}_b1`).get()).data().pixels.length, 3);
});

test("an invalid batch writes a userEvents entry with reason invalid", emulatorOnly, async () => {
  const { db, send } = setup();
  assert.equal(await send(draw("b1", [{ x: 100000, y: 1, color: 1 }])), 204);
  const event = (await db.doc(`userEvents/${UID}_b1`).get()).data();
  assert.deepEqual([event.reason, event.uid, event.pixels], ["invalid", UID, [{ x: 100000, y: 1, color: 1 }]]);
  assert.equal((await db.collection("pixels").get()).size, 0);
});

test("batch ids are scoped per user: the same id from two users draws both", emulatorOnly, async () => {
  const { db, send, published } = setup();
  const other = "223456789012345678";
  await send(draw("same", [{ x: 1, y: 1, color: 0x111111 }], UID, "alice"));
  await send(draw("same", [{ x: 2, y: 2, color: 0x222222 }], other, "bob"));
  assert.equal((await db.doc("pixels/1_1").get()).data().a, UID);
  assert.equal((await db.doc("pixels/2_2").get()).data().a, other);
  assert.ok((await db.doc(`processedBatches/${UID}_same`).get()).exists);
  assert.ok((await db.doc(`processedBatches/${other}_same`).get()).exists);
  assert.deepEqual(
    published.map((p) => [p.payload.userId, p.payload.pixels.map((px) => px.x)]).sort(),
    [[UID, [1]], [other, [2]]].sort(),
  );
});
