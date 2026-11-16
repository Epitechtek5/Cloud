import { test } from "node:test";
import assert from "node:assert/strict";
import { createSnapshotWorker } from "../../src/snapshot/worker.js";
import { createSnapshotBucket } from "../../src/snapshot/store.js";
import { createLogger } from "../../src/lib/logger.js";
import { captureLogs } from "../lib/helpers.js";
import { valid } from "../lib/fixtures.js";
import { decodePng } from "../lib/pngDecode.js";
import { response } from "../discord/helpers.js";
import { pushRequest } from "../commands/helpers.js";

const request = { ...valid["snapshot.requested"], requestedAt: Date.UTC(2026, 10, 16, 12, 0, 0), channelId: "1000000000000000002" };

function setup({ pixels = [{ x: 5, y: 5, c: 0xff0000, t: 1 }], truncated = false, exists = false, fail } = {}) {
  const out = captureLogs();
  const stored = [];
  const bucket = {
    create: async (name, data, metadata) => {
      if (fail) throw fail;
      stored.push({ name, data, metadata });
      return !exists;
    },
  };
  const worker = createSnapshotWorker({
    readPixels: async () => ({ pixels, truncated }),
    getBucket: async () => bucket,
    now: () => Date.UTC(2026, 10, 16, 12, 0, 1),
    logger: createLogger({}, { write: out.write }),
  });
  const send = async (payload) => {
    const res = response();
    res.end = () => res;
    await worker(pushRequest("snapshot.requested", payload), res);
    return res.statusCode;
  };
  return { send, stored, logs: out.lines };
}

test("renders a PNG and stores it with what the notifier needs, then stops", async () => {
  const { send, stored, logs } = setup();
  assert.equal(await send(request), 204);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].name, "snapshots/2026/11/16/2026-11-16T12-00-00-000Z_r-1.png");
  const png = decodePng(stored[0].data);
  assert.ok(png.width >= 512);
  assert.deepEqual(stored[0].metadata, {
    requestId: "r-1",
    requestedBy: request.requestedBy,
    requestedAt: "2026-11-16T12:00:00.000Z",
    renderedAt: "2026-11-16T12:00:01.000Z",
    correlationId: "corr-12345678",
    reason: "command",
    area: stored[0].metadata.area,
    pixels: "1",
    truncated: "false",
    applicationId: request.interaction.applicationId,
    interactionToken: request.interaction.token,
    channelId: request.channelId,
  });
  assert.ok(!JSON.stringify(logs).includes(request.interaction.token));
});

test("a redelivered request finds its object and does nothing more", async () => {
  const { send, logs } = setup({ exists: true });
  assert.equal(await send(request), 204);
  assert.ok(logs.some((l) => l.message === "snapshot already stored, nothing to do"));
});

test("a scheduled snapshot has no interaction; a truncated one is flagged", async () => {
  const { send, stored, logs } = setup({ truncated: true });
  const { interaction, channelId, requestedAt, ...scheduled } = request;
  await send({ ...scheduled, reason: "schedule" });
  assert.equal(stored[0].metadata.interactionToken, undefined);
  assert.equal(stored[0].metadata.truncated, "true");
  assert.match(stored[0].name, /^snapshots\/2026\/11\/16\/2026-11-16T12-00-01-000Z_r-1\.png$/);
  assert.ok(logs.some((l) => l.severity === "WARNING"));
});

test("a bucket failure is retried (500)", async () => {
  assert.equal(await setup({ fail: new Error("503") }).send(request), 500);
});

test("the bucket upload is create-only (412 means already there)", async () => {
  const saves = [];
  const fakeBucket = (error) => ({
    file: (name) => ({
      save: async (data, options) => {
        saves.push({ name, options });
        if (error) throw error;
      },
    }),
  });
  assert.equal(await createSnapshotBucket(fakeBucket()).create("n", Buffer.from("x"), { a: "1" }), true);
  assert.deepEqual(saves[0].options.preconditionOpts, { ifGenerationMatch: 0 });
  assert.equal(saves[0].options.contentType, "image/png");
  assert.deepEqual(saves[0].options.metadata.metadata, { a: "1" });
  assert.equal(await createSnapshotBucket(fakeBucket(Object.assign(new Error("exists"), { code: 412 }))).create("n", Buffer.from("x"), {}), false);
  await assert.rejects(createSnapshotBucket(fakeBucket(Object.assign(new Error("denied"), { code: 403 }))).create("n", Buffer.from("x"), {}), /denied/);
});
