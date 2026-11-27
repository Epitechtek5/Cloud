import { test } from "node:test";
import assert from "node:assert/strict";
import { createDrawWorker, identifyInvalid } from "../../src/draw/worker.js";
import { DiscordApiError } from "../../src/lib/discordWebhook.js";
import { createLogger } from "../../src/lib/logger.js";
import { response } from "../discord/helpers.js";
import { captureLogs } from "../lib/helpers.js";
import { valid } from "../lib/fixtures.js";
import { fakeDiscord, fakePublisher, pushRequest } from "../commands/helpers.js";

const batch = valid["pixel.draw"];
const interaction = valid["discord.command"].interaction;

function fakeStore(outcome = { accepted: batch.pixels, rejected: [], reason: null, quota: { limit: 20, used: 1 } }, { fail } = {}) {
  const calls = { apply: [], invalid: [] };
  return {
    calls,
    applyBatch: async (b) => {
      if (fail) throw fail;
      calls.apply.push(b);
      return { duplicate: calls.apply.length > 1, ...outcome };
    },
    rejectInvalid: async (who) => {
      if (fail) throw fail;
      calls.invalid.push(who);
    },
  };
}

function setup({ store = fakeStore(), discordFail, publishFail } = {}) {
  const out = captureLogs();
  const discord = fakeDiscord({ fail: discordFail });
  const { publisher, published } = fakePublisher({ fail: publishFail });
  const worker = createDrawWorker({ getStore: async () => store, publisher, discord, logger: createLogger({}, { write: out.write }) });
  const send = async (req) => {
    const res = response();
    res.end = () => res;
    await worker(req, res);
    return res.statusCode;
  };
  return { send, store, discord, published, logs: out.lines };
}

test("applies a web batch, emits pixel.processed with the correlation id, acks 204", async () => {
  const { send, store, published, discord, logs } = setup();
  assert.equal(await send(pushRequest("pixel.draw", batch)), 204);
  assert.deepEqual(store.calls.apply, [batch]);
  assert.equal(published[0].topic, "pixel.processed");
  assert.deepEqual(published[0].payload, { batchId: batch.batchId, userId: batch.user.id, pixels: batch.pixels, rejected: [] });
  assert.equal(published[0].attributes.correlation_id, "corr-12345678");
  assert.equal(discord.edits.length, 0);
  const line = logs.find((l) => l.message === "batch applied");
  assert.deepEqual([line.batchId, line.user_id, line.correlation_id, line.accepted], [batch.batchId, batch.user.id, "corr-12345678", 1]);
});

test("rejected pixels are fanned out with their reason", async () => {
  const pixel = { x: 3, y: 4, color: 5 };
  const { send, published } = setup({ store: fakeStore({ accepted: [], rejected: [pixel], reason: "paused", quota: null }) });
  await send(pushRequest("pixel.draw", batch));
  assert.deepEqual(published[0].payload.rejected, [{ x: 3, y: 4, reason: "paused" }]);
});

test("a redelivered batch replays its outcome (fan-out again, quota untouched by the store)", async () => {
  const { send, published, logs } = setup();
  await send(pushRequest("pixel.draw", batch));
  await send(pushRequest("pixel.draw", batch));
  assert.equal(published.length, 2);
  assert.ok(logs.some((l) => l.message === "batch already applied, outcome replayed"));
});

test("/draw batches edit the Discord answer", async () => {
  const { send, discord } = setup();
  await send(pushRequest("pixel.draw", { ...batch, source: "discord", interaction }));
  assert.match(discord.edits[0].message.content, /painted #ff0000/);
});

test("Discord failures: retryable -> 500, expired token -> acked", async () => {
  let { send } = setup({ discordFail: new DiscordApiError(500) });
  assert.equal(await send(pushRequest("pixel.draw", { ...batch, interaction })), 500);
  ({ send } = setup({ discordFail: new DiscordApiError(404) }));
  assert.equal(await send(pushRequest("pixel.draw", { ...batch, interaction })), 204);
});

test("Firestore or Pub/Sub down -> 500 (retried)", async () => {
  assert.equal(await setup({ store: fakeStore(undefined, { fail: new Error("unavailable") }) }).send(pushRequest("pixel.draw", batch)), 500);
  assert.equal(await setup({ publishFail: new Error("down") }).send(pushRequest("pixel.draw", batch)), 500);
});

test("an invalid batch from a known user is recorded as invalid and acked", async () => {
  const { send, store, published } = setup();
  const bad = { ...batch, pixels: [{ x: 100000, y: 0, color: 1 }, { x: "a", y: 0, color: 1 }] };
  assert.equal(await send(pushRequest("pixel.draw", bad)), 204);
  assert.deepEqual(store.calls.invalid, [{ batchId: batch.batchId, uid: batch.user.id, pixels: [{ x: 100000, y: 0, color: 1 }] }]);
  assert.equal(published.length, 0);
});

test("an anonymous broken message goes to the DLQ (400); a failed record is retried (500)", async () => {
  const { send, store } = setup();
  assert.equal(await send(pushRequest("pixel.draw", null, { data: "%%%" })), 400);
  assert.equal(await send(pushRequest("pixel.draw", { pixels: [] })), 400);
  assert.equal(store.calls.invalid.length, 0);
  const failing = setup({ store: fakeStore(undefined, { fail: new Error("down") }) });
  assert.equal(await failing.send(pushRequest("pixel.draw", { ...batch, pixels: [] })), 500);
});

test("identifyInvalid only trusts a well-formed batch id and user id", () => {
  const body = (payload, type = "pixel.draw") => pushRequest(type, payload).body;
  assert.equal(identifyInvalid(body({ batchId: "a b", user: { id: "123456" } })), null);
  assert.equal(identifyInvalid(body({ batchId: "b", user: { id: "bob" } })), null);
  assert.equal(identifyInvalid(body({ batchId: "b", user: { id: "123456" } }, "discord.command")), null);
  assert.equal(identifyInvalid({}), null);
  assert.deepEqual(identifyInvalid(body({ batchId: "b", user: { id: "123456" }, pixels: "x" })), { batchId: "b", uid: "123456", pixels: [] });
});
