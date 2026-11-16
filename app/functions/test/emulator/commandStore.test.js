// Command worker against the Firestore emulator: the real transactions,
// markers and documents, end to end through the HTTP handler.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "@google-cloud/firestore";
import { createCommandStore, MARKER_TTL_MS } from "../../src/commands/store.js";
import { createCommandWorker } from "../../src/commands/worker.js";
import { readSession } from "../../src/lib/canvas.js";
import { createLogger } from "../../src/lib/logger.js";
import { response } from "../discord/helpers.js";
import { ADMIN_ROLE, command, config, fakeDiscord, fakePublisher, pushRequest } from "../commands/helpers.js";
import { emulatorDb, emulatorOnly, resetEmulator } from "./helpers.js";

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);

function setup() {
  const db = emulatorDb();
  const store = createCommandStore(db, { now: () => NOW });
  const discord = fakeDiscord();
  const { publisher, published } = fakePublisher();
  const worker = createCommandWorker({
    getStore: async () => store,
    publisher,
    discord,
    config,
    logger: createLogger({}, { write: () => {} }),
  });
  const send = async (event) => {
    const res = response();
    res.end = () => res;
    await worker(pushRequest("discord.command", event), res);
    return res.statusCode;
  };
  return { db, store, discord, published, send };
}

beforeEach(async () => {
  if (!emulatorOnly.skip) await resetEmulator();
});

test("pause then resume write session/state; a late redelivery of the pause changes nothing", emulatorOnly, async () => {
  const { db, send } = setup();
  const pause = command("admin", { subcommand: "pause", roles: [ADMIN_ROLE], id: "1300000000000000001" });
  const resume = command("admin", { subcommand: "resume", roles: [ADMIN_ROLE], id: "1300000000000000002" });
  assert.equal(await send(pause), 204);
  assert.equal((await readSession(db)).paused, true);
  assert.equal(await send(resume), 204);
  assert.equal(await send(pause), 204);
  const state = (await db.doc("session/state").get()).data();
  assert.equal(state.paused, false);
  assert.equal(state.updatedBy, resume.user.id);

  const marker = (await db.doc("processedCommands/1300000000000000001").get()).data();
  assert.equal(marker.command, "admin");
  assert.equal(marker.subcommand, "pause");
  assert.equal(marker.expireAt.toMillis(), NOW + MARKER_TTL_MS);
});

test("a non-admin /admin clear is refused and writes nothing", emulatorOnly, async () => {
  const { db, send, discord } = setup();
  assert.equal(await send(command("admin", { subcommand: "clear" })), 204);
  assert.match(discord.edits[0].message.content, /not allowed/);
  assert.equal((await db.doc("session/state").get()).exists, false);
  assert.equal((await db.collection("processedCommands").get()).size, 0);
});

test("clear bumps the generation once even when delivered twice", emulatorOnly, async () => {
  const { db, send } = setup();
  const clear = command("admin", { subcommand: "clear", roles: [ADMIN_ROLE], id: "1300000000000000003" });
  await Promise.all([send(clear), send(clear)]);
  await send(clear);
  const state = (await db.doc("session/state").get()).data();
  assert.equal(state.epoch, 1);
  assert.ok(state.clearedAt instanceof Timestamp);
  assert.ok((await readSession(db)).clearedAt > 0);
});

test("ratelimit stores the override on users/{uid}", emulatorOnly, async () => {
  const { db, send } = setup();
  await db.doc("users/123456789012345678").set({ used: 3 });
  await send(command("admin", { subcommand: "ratelimit", roles: [ADMIN_ROLE], options: { user: "123456789012345678", limit: 7 } }));
  const user = (await db.doc("users/123456789012345678").get()).data();
  assert.equal(user.override, 7);
  assert.equal(user.limit, 7);
  assert.equal(user.used, 3);
});

test("/get reads only the region, and only pixels newer than the last clear", emulatorOnly, async () => {
  const { db, store } = setup();
  const pixel = (x, y, c, t) => db.doc(`pixels/${x}_${y}`).set({ x, y, tile: `${Math.floor(x / 256)}_${Math.floor(y / 256)}`, c, a: "1", an: "a", t: Timestamp.fromMillis(t) });
  await Promise.all([pixel(10, 10, 0xff0000, 2000), pixel(300, 10, 0x00ff00, 2000), pixel(11, 10, 0x0000ff, 500), pixel(20, 20, 0x123456, 3000)]);
  const pixels = await store.readRegion({ x0: 0, y0: 0, size: 16, clearedAt: 1000 });
  assert.deepEqual(pixels, [{ x: 10, y: 10, c: 0xff0000 }]);
  const wide = await store.readRegion({ x0: 0, y0: 0, size: 512, clearedAt: 0 });
  assert.equal(wide.length, 4);
});

test("snapshot is published once and recorded", emulatorOnly, async () => {
  const { send, published, store } = setup();
  const snap = command("snapshot", { roles: [ADMIN_ROLE], id: "1300000000000000004" });
  await send(snap);
  await send(snap);
  assert.equal(published.filter((p) => p.topic === "snapshot.requested").length, 1);
  assert.match((await store.processed("1300000000000000004")).reply.content, /Snapshot requested/);
  assert.equal(await store.processed("1300000000000000005"), null);
});
