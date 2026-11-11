import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCommands, registerCommands, sameCommands, validateCommands } from "../../commands/register.js";
import { parseColor } from "../../src/lib/colors.js";
import { GRID_SIZE } from "../../src/lib/events.js";

const commands = await loadCommands();
const byName = Object.fromEntries(commands.map((c) => [c.name, c]));
const TOKEN = "secret-bot-token-value";

// A fake Discord API that stores the registered commands like Discord does
// (adding ids, versions and default fields).
function fakeDiscord(initial = []) {
  const state = { registered: initial, calls: [] };
  state.fetch = async (url, init) => {
    state.calls.push({ url, method: init.method, auth: init.headers.Authorization });
    if (init.method === "PUT") {
      state.registered = JSON.parse(init.body).map((c, i) => ({
        id: String(1000 + i),
        application_id: "1100000000000000001",
        version: "1",
        nsfw: false,
        dm_permission: false,
        integration_types: [0],
        ...c,
        options: c.options?.map((o) => ({ required: false, ...o })),
      }));
    }
    return { ok: true, status: 200, json: async () => state.registered, text: async () => "" };
  };
  return state;
}

const run = (fake, extra = {}) =>
  registerCommands({
    commands,
    token: TOKEN,
    applicationId: "1100000000000000001",
    guildId: "1000000000000000001",
    fetchImpl: fake.fetch,
    log: () => {},
    ...extra,
  });

test("the mandatory commands are defined (subject 3.2)", () => {
  assert.deepEqual(Object.keys(byName).sort(), ["admin", "draw", "get", "snapshot"]);
  assert.deepEqual(
    byName.admin.options.map((o) => o.name),
    ["pause", "resume", "clear", "ratelimit"],
  );
  assert.deepEqual(
    byName.admin.options.find((o) => o.name === "ratelimit").options.map((o) => [o.name, o.type]),
    [
      ["user", 6],
      ["limit", 4],
    ],
  );
  assert.deepEqual(validateCommands(commands), []);
});

test("x and y match the grid, color is a short string", () => {
  for (const name of ["x", "y"]) {
    const option = byName.draw.options.find((o) => o.name === name);
    assert.equal(option.min_value, 0);
    assert.equal(option.max_value, GRID_SIZE - 1);
  }
  const color = byName.draw.options.find((o) => o.name === "color");
  assert.equal(color.max_length, 7);
  assert.equal(parseColor("#ff0000"), 0xff0000);
  assert.equal(parseColor("purple"), 0x820080);
});

test("admin commands need Administrator as a first barrier", () => {
  assert.equal(byName.admin.default_member_permissions, "8");
  assert.equal(byName.snapshot.default_member_permissions, "8");
  assert.equal(byName.draw.default_member_permissions, undefined);
  assert.equal(byName.get.default_member_permissions, undefined);
});

test("registration is idempotent: the second run changes nothing", async () => {
  const fake = fakeDiscord();
  assert.equal(await run(fake), "updated");
  assert.equal(await run(fake), "unchanged");
  assert.deepEqual(
    fake.calls.map((c) => c.method),
    ["GET", "PUT", "GET"],
  );
  assert.ok(fake.calls.every((c) => c.url.endsWith("/applications/1100000000000000001/guilds/1000000000000000001/commands")));
  assert.ok(fake.calls.every((c) => c.auth === `Bot ${TOKEN}`));
});

test("a changed definition is written again; dry run writes nothing", async () => {
  const fake = fakeDiscord();
  await run(fake);
  const changed = structuredClone(commands);
  changed[0].description = "Paint a pixel";
  assert.equal(await run(fake, { commands: changed, dryRun: true }), "dry-run");
  assert.equal(await run(fake, { commands: changed }), "updated");
  assert.equal(fake.registered[0].description, "Paint a pixel");
});

test("global registration without a guild", async () => {
  const fake = fakeDiscord();
  await run(fake, { guildId: undefined });
  assert.ok(fake.calls[0].url.endsWith("/applications/1100000000000000001/commands"));
});

test("never prints the token", async () => {
  const lines = [];
  await run(fakeDiscord(), { log: (l) => lines.push(l) });
  assert.ok(lines.length > 0);
  assert.ok(lines.every((l) => !l.includes(TOKEN)));
});

test("refuses bad inputs before calling Discord", async () => {
  const fake = fakeDiscord();
  await assert.rejects(run(fake, { token: undefined }), /DISCORD_BOT_TOKEN/);
  await assert.rejects(run(fake, { applicationId: "abc" }), /application-id/);
  await assert.rejects(run(fake, { guildId: "abc" }), /guild-id/);
  await assert.rejects(run(fake, { commands: [{ name: "Bad Name", description: "" }] }), /invalid command definitions/);
  assert.equal(fake.calls.length, 0);
});

test("validation catches Discord limit violations", () => {
  assert.deepEqual(validateCommands([]), ["commands must be a non-empty array"]);
  const errors = validateCommands([
    { name: "a", description: "x".repeat(101) },
    { name: "a", description: "ok", options: [{ name: "o", description: "d", min_value: 5, max_value: 1 }] },
    { name: "b", description: "ok", options: [{ name: "opt", type: 3, description: "d" }, { name: "req", type: 3, description: "d", required: true }] },
  ]);
  assert.ok(errors.some((e) => e.includes("description must be 1-100")));
  assert.ok(errors.some((e) => e.includes("duplicate")));
  assert.ok(errors.some((e) => e.includes("min_value > max_value")));
  assert.ok(errors.some((e) => e.includes("required options must come first")));
});

test("retries after a 429 and reports API errors without the token", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, json: async () => ({ retry_after: 0 }), text: async () => "" };
    return { ok: false, status: 403, json: async () => ({}), text: async () => '{"message":"Missing Access"}' };
  };
  await assert.rejects(run({ fetch: fetchImpl }), (err) => err.message.includes("403") && !err.message.includes(TOKEN));
  assert.equal(calls, 2);
});

test("sameCommands compares only the defined fields", () => {
  assert.equal(sameCommands([{ name: "a", description: "d" }], [{ name: "a", description: "d", id: "1", version: "2" }]), true);
  assert.equal(sameCommands([{ name: "a", description: "d" }], [{ name: "a", description: "e" }]), false);
  assert.equal(sameCommands([{ name: "a", description: "d" }], []), false);
});
