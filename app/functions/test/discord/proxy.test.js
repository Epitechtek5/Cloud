import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiscordProxy } from "../../src/discord/proxy.js";
import { createLogger } from "../../src/lib/logger.js";
import { createPublisher } from "../../src/lib/publisher.js";
import { captureLogs } from "../lib/helpers.js";
import { discordKeys, drawInteraction, response, signedRequest } from "./helpers.js";

const keys = discordKeys();

function setup({ getPublicKey = async () => keys.publicHex, publishError } = {}) {
  const out = captureLogs();
  const published = [];
  const client = {
    topic: (name) => ({
      publishMessage: async (msg) => {
        if (publishError) throw publishError;
        published.push({ topic: name, ...msg });
        return "msg-1";
      },
    }),
  };
  const proxy = createDiscordProxy({
    getPublicKey,
    publisher: createPublisher({ source: "discord-proxy", client }),
    logger: createLogger({ function: "discord-proxy" }, { write: out.write }),
  });
  return { proxy, published, logs: out.lines };
}

test("answers PING with PONG", async () => {
  const { proxy, published } = setup();
  const res = response();
  await proxy(signedRequest(keys, { type: 1 }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { type: 1 });
  assert.equal(published.length, 0);
});

test("401 on a missing, bad or foreign signature, before anything else", async () => {
  const { proxy, published } = setup();
  const cases = [
    signedRequest(keys, { type: 1 }, { signature: "" }),
    signedRequest(keys, { type: 1 }, { signature: "00".repeat(64) }),
    signedRequest(discordKeys(), drawInteraction),
    { ...signedRequest(keys, { type: 1 }), rawBody: Buffer.from('{"type":2}') },
    signedRequest(keys, { type: 1 }, { timestamp: "1000" }),
  ];
  for (const req of cases) {
    const res = response();
    await proxy(req, res);
    assert.equal(res.statusCode, 401);
  }
  assert.equal(published.length, 0);
});

test("publishes a slash command on discord.command and defers the answer", async () => {
  const { proxy, published, logs } = setup();
  const res = response();
  await proxy(signedRequest(keys, drawInteraction, { headers: { "x-correlation-id": "corr-from-test" } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { type: 5 });
  assert.equal(res.headers["X-Correlation-Id"], "corr-from-test");
  assert.equal(published.length, 1);
  assert.equal(published[0].topic, "discord.command");
  assert.equal(published[0].json.command, "draw");
  assert.equal(published[0].json.interaction.token, "interaction-token");
  assert.deepEqual(published[0].attributes, { correlation_id: "corr-from-test", event_type: "discord.command", source: "discord-proxy" });
  const accepted = logs.find((l) => l.message === "command accepted");
  assert.equal(accepted.correlation_id, "corr-from-test");
  assert.equal(accepted.user_id, "123456789012345678");
});

test("admin commands are deferred ephemerally", async () => {
  const { proxy } = setup();
  const res = response();
  const admin = { ...drawInteraction, data: { name: "admin", options: [{ name: "pause", type: 1 }] } };
  await proxy(signedRequest(keys, admin), res);
  assert.deepEqual(res.body, { type: 5, data: { flags: 64 } });
});

test("500 when the command cannot be published (Discord shows a failure)", async () => {
  const { proxy } = setup({ publishError: new Error("PERMISSION_DENIED") });
  const res = response();
  await proxy(signedRequest(keys, drawInteraction), res);
  assert.equal(res.statusCode, 500);
});

test("500 when the public key cannot be read, retried on the next request", async () => {
  let calls = 0;
  const { proxy } = setup({
    getPublicKey: async () => {
      calls++;
      if (calls === 1) throw new Error("secret unavailable");
      return keys.publicHex;
    },
  });
  const first = response();
  await proxy(signedRequest(keys, { type: 1 }), first);
  assert.equal(first.statusCode, 500);
  const second = response();
  await proxy(signedRequest(keys, { type: 1 }), second);
  assert.equal(second.statusCode, 200);
  const third = response();
  await proxy(signedRequest(keys, { type: 1 }), third);
  assert.equal(calls, 2, "the key is cached once read");
});

test("405 on other methods, 400 on unsupported types or unparsable bodies", async () => {
  const { proxy } = setup();
  const get = response();
  await proxy(signedRequest(keys, { type: 1 }, { method: "GET" }), get);
  assert.equal(get.statusCode, 405);

  const component = response();
  await proxy(signedRequest(keys, { type: 3 }), component);
  assert.equal(component.statusCode, 400);

  const notJson = response();
  await proxy(signedRequest(keys, "not json"), notJson);
  assert.equal(notJson.statusCode, 400);

  const rawOnly = response();
  await proxy({ ...signedRequest(keys, { type: 1 }), body: undefined }, rawOnly);
  assert.deepEqual(rawOnly.body, { type: 1 });
});
