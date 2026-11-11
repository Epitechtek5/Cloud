import { test } from "node:test";
import assert from "node:assert/strict";
import { deferredResponse, flattenOptions, toCommandEvent } from "../../src/discord/interaction.js";
import { validateEvent } from "../../src/lib/events.js";
import { drawInteraction } from "./helpers.js";

test("flattens plain options", () => {
  assert.deepEqual(flattenOptions(drawInteraction.data), { subcommand: null, options: { x: 10, y: 20, color: "#ff0000" } });
  assert.deepEqual(flattenOptions({ name: "get" }), { subcommand: null, options: {} });
  assert.deepEqual(flattenOptions(undefined), { subcommand: null, options: {} });
});

test("flattens subcommands and subcommand groups", () => {
  const ratelimit = {
    name: "admin",
    options: [{ name: "ratelimit", type: 1, options: [{ name: "user", type: 6, value: "42" }, { name: "limit", type: 4, value: 5 }] }],
  };
  assert.deepEqual(flattenOptions(ratelimit), { subcommand: "ratelimit", options: { user: "42", limit: 5 } });
  assert.deepEqual(flattenOptions({ name: "admin", options: [{ name: "pause", type: 1 }] }), { subcommand: "pause", options: {} });
  const group = { name: "a", options: [{ name: "g", type: 2, options: [{ name: "s", type: 1, options: [] }] }] };
  assert.deepEqual(flattenOptions(group), { subcommand: "g s", options: {} });
});

test("builds a valid discord.command event from a guild interaction", () => {
  const event = toCommandEvent(drawInteraction);
  assert.deepEqual(event, {
    interaction: { id: "1200000000000000001", applicationId: "1100000000000000001", token: "interaction-token" },
    command: "draw",
    subcommand: null,
    options: { x: 10, y: 20, color: "#ff0000" },
    guildId: "1000000000000000001",
    channelId: "1000000000000000002",
    user: { id: "123456789012345678", name: "Alice" },
    memberRoles: ["1000000000000000003"],
    memberPermissions: "2147483647",
  });
  assert.deepEqual(validateEvent("discord.command", event), { ok: true });
});

test("builds a valid event from a DM interaction (no member)", () => {
  const { member, guild_id, channel_id, ...dm } = drawInteraction;
  void member, guild_id, channel_id;
  const event = toCommandEvent({ ...dm, user: { id: "123456789012345678", username: "alice" }, channel: { id: "1000000000000000009" } });
  assert.deepEqual(event.user, { id: "123456789012345678", name: "alice" });
  assert.equal(event.guildId, null);
  assert.equal(event.channelId, "1000000000000000009");
  assert.deepEqual(event.memberRoles, []);
  assert.equal(event.memberPermissions, null);
  assert.deepEqual(validateEvent("discord.command", event), { ok: true });
});

test("defers publicly, and ephemerally for admin commands", () => {
  assert.deepEqual(deferredResponse("draw"), { type: 5 });
  assert.deepEqual(deferredResponse("admin"), { type: 5, data: { flags: 64 } });
});
