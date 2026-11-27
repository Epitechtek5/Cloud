import { test } from "node:test";
import assert from "node:assert/strict";
import { createCommandWorker } from "../../src/commands/worker.js";
import { loadCommandConfig, parseIds } from "../../src/commands/config.js";
import { DiscordApiError } from "../../src/lib/discordWebhook.js";
import { createLogger } from "../../src/lib/logger.js";
import { response } from "../discord/helpers.js";
import { captureLogs } from "../lib/helpers.js";
import { ADMIN_ROLE, command, config, fakeDiscord, fakePublisher, fakeStore, pushRequest } from "./helpers.js";

function setup({ store = fakeStore(), discordFail, publishFail } = {}) {
  const out = captureLogs();
  const discord = fakeDiscord({ fail: discordFail });
  const { publisher, published } = fakePublisher({ fail: publishFail });
  const worker = createCommandWorker({
    getStore: async () => store,
    publisher,
    discord,
    config,
    logger: createLogger({ function: "command-worker" }, { write: out.write }),
  });
  return { worker, store, discord, published, logs: out.lines };
}

async function call(worker, req) {
  const res = response();
  res.end = () => res;
  await worker(req, res);
  return res;
}

test("processes a command, edits the deferred response and acks with 204", async () => {
  const { worker, discord, store, logs } = setup();
  const event = command("admin", { subcommand: "pause", roles: [ADMIN_ROLE] });
  const res = await call(worker, pushRequest("discord.command", event));
  assert.equal(res.statusCode, 204);
  assert.equal(store.state.session.paused, true);
  assert.equal(discord.edits.length, 1);
  assert.deepEqual(discord.edits[0].interaction, event.interaction);
  const line = logs.find((l) => l.message === "command processed");
  assert.equal(line.correlation_id, "corr-12345678");
  assert.equal(line.user_id, event.user.id);
  // The interaction token never reaches the logs.
  assert.ok(!JSON.stringify(logs).includes(event.interaction.token));
});

test("a refused admin command is answered, logged as a warning and acked", async () => {
  const { worker, discord, store, logs } = setup();
  const res = await call(worker, pushRequest("discord.command", command("admin", { subcommand: "clear" })));
  assert.equal(res.statusCode, 204);
  assert.equal(store.state.clears, 0);
  assert.match(discord.edits[0].message.content, /not allowed/);
  assert.equal(logs.find((l) => l.message === "admin command refused").severity, "WARNING");
});

test("redelivering the same message twice has no side effect", async () => {
  const { worker, store, discord } = setup();
  const req = pushRequest("discord.command", command("admin", { subcommand: "clear", roles: [ADMIN_ROLE] }));
  assert.equal((await call(worker, req)).statusCode, 204);
  assert.equal((await call(worker, req)).statusCode, 204);
  assert.equal(store.state.clears, 1);
  // Same answer both times (edits the same message).
  assert.deepEqual(discord.edits[0].message, discord.edits[1].message);
});

test("/draw is not answered by the command worker", async () => {
  const { worker, discord, published } = setup();
  const res = await call(worker, pushRequest("discord.command", command("draw", { options: { x: 1, y: 1, color: "blue" } })));
  assert.equal(res.statusCode, 204);
  assert.equal(discord.edits.length, 0);
  assert.equal(published[0].topic, "pixel.draw");
});

test("400 for a broken message (it goes to the DLQ), 405 for another method", async () => {
  const { worker, logs } = setup();
  assert.equal((await call(worker, pushRequest("discord.command", null, { data: "not json" }))).statusCode, 400);
  assert.equal((await call(worker, pushRequest("pixel.draw", {}))).statusCode, 400);
  assert.equal((await call(worker, pushRequest("discord.command", { command: "draw" }))).statusCode, 400);
  assert.equal((await call(worker, { method: "POST", headers: {}, body: {} })).statusCode, 400);
  assert.equal((await call(worker, { method: "GET", headers: {} })).statusCode, 405);
  assert.ok(logs.every((l) => l.severity === "ERROR"));
});

test("500 (retried) when publishing or a retryable Discord call fails", async () => {
  let { worker } = setup({ publishFail: new Error("pubsub down") });
  assert.equal((await call(worker, pushRequest("discord.command", command("draw", { options: { x: 1, y: 1, color: "red" } })))).statusCode, 500);

  ({ worker } = setup({ discordFail: new DiscordApiError(503) }));
  assert.equal((await call(worker, pushRequest("discord.command", command("get")))).statusCode, 500);

  ({ worker } = setup({ discordFail: new TypeError("bug") }));
  assert.equal((await call(worker, pushRequest("discord.command", command("get")))).statusCode, 500);
});

test("an expired interaction token is logged and acked, not retried forever", async () => {
  const { worker, logs } = setup({ discordFail: new DiscordApiError(404, "10015") });
  assert.equal((await call(worker, pushRequest("discord.command", command("get")))).statusCode, 204);
  assert.equal(logs.find((l) => l.message === "cannot answer the interaction").status, 404);
});

test("configuration: admin ids from JSON or a comma list, fail closed", () => {
  assert.deepEqual([...parseIds('["123456", "1234567"]', "X")], ["123456", "1234567"]);
  assert.deepEqual([...parseIds(" 123456 , 1234567,", "X")], ["123456", "1234567"]);
  assert.equal(parseIds(undefined, "X").size, 0);
  assert.equal(parseIds("  ", "X").size, 0);
  assert.throws(() => parseIds("[bad", "ADMIN_ROLE_IDS"), /ADMIN_ROLE_IDS/);
  assert.throws(() => parseIds('{"a":1}', "X"), /list/);
  assert.throws(() => parseIds("alice", "X"), /Discord ids/);

  const loaded = loadCommandConfig({ ADMIN_ROLE_IDS: '["123456"]', APP_URL: "https://x/" });
  assert.deepEqual([...loaded.adminRoleIds], ["123456"]);
  assert.equal(loaded.adminUserIds.size, 0);
  assert.equal(loaded.appUrl, "https://x/");
  assert.equal(loaded.getDefaultSize, 128);
  assert.equal(loadCommandConfig({ GET_DEFAULT_SIZE: "64" }).getDefaultSize, 64);
  assert.equal(loadCommandConfig({}).appUrl, "");
  assert.throws(() => loadCommandConfig({ GET_DEFAULT_SIZE: "8" }), /GET_DEFAULT_SIZE/);
});
