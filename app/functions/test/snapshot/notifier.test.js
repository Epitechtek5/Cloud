import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Storage } from "@google-cloud/storage";
import { createSnapshotNotifier, createStorageSigner, decodeStorageNotification } from "../../src/snapshot/notifier.js";
import { DiscordApiError } from "../../src/lib/discordWebhook.js";
import { createLogger } from "../../src/lib/logger.js";
import { captureLogs } from "../lib/helpers.js";
import { response } from "../discord/helpers.js";
import { fakeDiscord } from "../commands/helpers.js";

const object = {
  bucket: "p-snapshots",
  name: "snapshots/2026/11/16/2026-11-16T12-00-00-000Z_1300000000000000004.png",
  timeCreated: "2026-11-16T12:00:02Z",
  metadata: {
    requestId: "1300000000000000004",
    requestedBy: "123456789012345678",
    requestedAt: "2026-11-16T12:00:00.000Z",
    correlationId: "corr-12345678",
    pixels: "42",
    applicationId: "1100000000000000001",
    interactionToken: "secret-token",
  },
};

/** A Cloud Storage notification as Pub/Sub pushes it (JSON_API_V1 payload). */
function notification(obj = object, eventType = "OBJECT_FINALIZE") {
  return {
    method: "POST",
    headers: {},
    body: {
      message: {
        data: Buffer.from(JSON.stringify(obj)).toString("base64"),
        attributes: { eventType, bucketId: obj.bucket, objectId: obj.name, payloadFormat: "JSON_API_V1", event_type: "snapshot.ready" },
        messageId: "9",
      },
    },
  };
}

function setup({ discordFail, signFail } = {}) {
  const out = captureLogs();
  const discord = fakeDiscord({ fail: discordFail });
  const signed = [];
  const signer = {
    sign: async (bucket, name, ttl) => {
      if (signFail) throw signFail;
      signed.push({ bucket, name, ttl });
      return `https://storage.googleapis.com/${bucket}/${name}?X-Goog-Signature=abc`;
    },
  };
  const notifier = createSnapshotNotifier({ signer, discord, ttlSeconds: 900, logger: createLogger({}, { write: out.write }) });
  const send = async (req) => {
    const res = response();
    res.end = () => res;
    await notifier(req, res);
    return res.statusCode;
  };
  return { send, discord, signed, logs: out.lines };
}

test("signs the new snapshot and edits the /snapshot answer with the link", async () => {
  const { send, discord, signed, logs } = setup();
  assert.equal(await send(notification()), 204);
  assert.deepEqual(signed, [{ bucket: "p-snapshots", name: object.name, ttl: 900 }]);
  assert.deepEqual(discord.edits[0].interaction, { id: object.metadata.requestId, applicationId: "1100000000000000001", token: "secret-token" });
  assert.match(discord.edits[0].message.content, /X-Goog-Signature=abc/);
  assert.match(discord.edits[0].message.content, /expires in 15 min/);
  const line = logs.find((l) => l.message === "snapshot link posted");
  assert.equal(line.correlation_id, "corr-12345678");
  assert.ok(!JSON.stringify(logs).includes("secret-token"));
  assert.ok(!JSON.stringify(logs).includes("X-Goog-Signature"));
});

test("ignores other events, other objects and snapshots without interaction", async () => {
  const { send, discord } = setup();
  assert.equal(await send(notification(object, "OBJECT_DELETE")), 204);
  assert.equal(await send(notification({ ...object, name: "tmp/x.png" })), 204);
  assert.equal(await send(notification({ ...object, metadata: { requestId: "r" } })), 204);
  assert.equal(await send(notification({ ...object, metadata: undefined })), 204);
  assert.equal(discord.edits.length, 0);
});

test("broken notifications go to the DLQ (400), other methods get 405", async () => {
  const { send } = setup();
  assert.equal(await send({ method: "POST", headers: {}, body: {} }), 400);
  const bad = notification();
  bad.body.message.data = "%%%";
  assert.equal(await send(bad), 400);
  assert.equal(await send(notification({ hello: 1 })), 400);
  assert.equal(await send({ method: "GET", headers: {} }), 405);
  assert.deepEqual(decodeStorageNotification(notification({ ...object, name: "snapshots/a.txt" }).body), { skip: "not a snapshot" });
});

test("retries on signing or transient Discord failures, gives up on an expired token", async () => {
  assert.equal(await setup({ signFail: new Error("iam") }).send(notification()), 500);
  assert.equal(await setup({ discordFail: new DiscordApiError(502) }).send(notification()), 500);
  assert.equal(await setup({ discordFail: new DiscordApiError(404) }).send(notification()), 204);
});

test("the signed URL is a V4 GET URL that expires after the configured lifetime", async () => {
  // A throwaway key stands for the service account (in Cloud Run the library
  // signs through IAM signBlob instead, with the same URL format).
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const storage = new Storage({
    projectId: "demo",
    credentials: { client_email: "fn-snapshot-notifier@demo.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) },
  });
  const url = new URL(await createStorageSigner(storage).sign("p-snapshots", object.name, 900));
  assert.equal(url.host, "storage.googleapis.com");
  assert.equal(url.pathname, `/p-snapshots/${object.name}`);
  assert.equal(url.searchParams.get("X-Goog-Algorithm"), "GOOG4-RSA-SHA256");
  assert.equal(url.searchParams.get("X-Goog-Expires"), "900");
  assert.match(url.searchParams.get("X-Goog-Credential"), /^fn-snapshot-notifier@demo\.iam\.gserviceaccount\.com\//);
  assert.match(url.searchParams.get("X-Goog-Signature"), /^[\da-f]{512}$/);
});
