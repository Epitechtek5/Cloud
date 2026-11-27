import { test } from "node:test";
import assert from "node:assert/strict";
import { handleCommand, REPLIES } from "../../src/commands/commands.js";
import { isAdmin, requiresAdmin } from "../../src/commands/authorize.js";
import { snowflakeTime } from "../../src/lib/snowflake.js";
import { decodePng } from "../lib/pngDecode.js";
import { ADMIN_ROLE, ADMIN_USER, command, config, fakePublisher, fakeStore } from "./helpers.js";

function deps(overrides = {}) {
  const store = overrides.store ?? fakeStore();
  const { publisher, published } = fakePublisher();
  return { store, publisher, published, config, correlationId: "corr-12345678", ...overrides };
}

test("admin: configured role or user id only, never the Discord permission bitfield", () => {
  assert.equal(isAdmin(command("admin"), config), false);
  assert.equal(isAdmin(command("admin", { roles: ["1", ADMIN_ROLE] }), config), true);
  assert.equal(isAdmin(command("admin", { userId: ADMIN_USER }), config), true);
  assert.equal(isAdmin(command("admin", { roles: [ADMIN_ROLE] }), { adminRoleIds: new Set(), adminUserIds: new Set() }), false);
  assert.ok(requiresAdmin("admin"));
  assert.ok(!requiresAdmin("draw") && !requiresAdmin("get") && !requiresAdmin("snapshot"));
});

test("a non-admin running /admin * is refused and nothing changes", async () => {
  for (const [name, subcommand, options] of [
    ["admin", "pause"],
    ["admin", "resume"],
    ["admin", "clear"],
    ["admin", "ratelimit", { user: "123456789012345678", limit: 999 }],
  ]) {
    const d = deps();
    const out = await handleCommand(command(name, { subcommand, options }), d);
    assert.equal(out.authorized, false);
    assert.deepEqual(out.reply, { content: REPLIES.forbidden });
    assert.equal(d.published.length, 0);
    assert.equal(d.store.markers.size, 0);
    assert.deepEqual(d.store.state, { session: { paused: false, clearedAt: 0 }, users: {}, clears: 0, regions: [] });
  }
});

test("/admin pause and resume set session/state, once per interaction", async () => {
  const d = deps();
  const pause = command("admin", { subcommand: "pause", roles: [ADMIN_ROLE], id: "1300000000000000001" });
  assert.deepEqual((await handleCommand(pause, d)).reply, { content: REPLIES.paused });
  assert.equal(d.store.state.session.paused, true);

  const resume = command("admin", { subcommand: "resume", roles: [ADMIN_ROLE], id: "1300000000000000002" });
  assert.deepEqual((await handleCommand(resume, d)).reply, { content: REPLIES.resumed });
  assert.equal(d.store.state.session.paused, false);

  // The pause is redelivered after the resume: it must not pause again.
  assert.deepEqual((await handleCommand(pause, d)).reply, { content: REPLIES.paused });
  assert.equal(d.store.state.session.paused, false);
});

test("/admin clear bumps the generation once and fans out a single cleared signal", async () => {
  const d = deps();
  const clear = command("admin", { subcommand: "clear", userId: ADMIN_USER, id: "1300000000000000003" });
  assert.deepEqual((await handleCommand(clear, d)).reply, { content: REPLIES.cleared });
  await handleCommand(clear, d);
  assert.equal(d.store.state.clears, 1);
  // Published on each delivery, with the same batch id: consumers dedupe it.
  assert.equal(d.published.length, 2);
  assert.deepEqual(d.published[0].payload, { batchId: "clear-1300000000000000003", userId: ADMIN_USER, cleared: true, pixels: [] });
  assert.equal(d.published[0].topic, "pixel.processed");
  assert.equal(d.published[0].attributes.correlation_id, "corr-12345678");
});

test("/admin ratelimit writes the user override", async () => {
  const d = deps();
  const out = await handleCommand(
    command("admin", { subcommand: "ratelimit", roles: [ADMIN_ROLE], options: { user: "123456789012345678", limit: 5 } }),
    d,
  );
  assert.equal(d.store.state.users["123456789012345678"], 5);
  assert.match(out.reply.content, /<@123456789012345678> can now draw 5 pixel/);

  for (const options of [{ user: "bob", limit: 5 }, { user: "123456789012345678", limit: 1001 }, { user: "123456789012345678" }]) {
    const bad = await handleCommand(command("admin", { subcommand: "ratelimit", roles: [ADMIN_ROLE], options }), deps());
    assert.match(bad.reply.content, /Usage/);
  }
});

test("/admin with an unknown subcommand, and an unknown command", async () => {
  assert.deepEqual((await handleCommand(command("admin", { subcommand: "nuke", roles: [ADMIN_ROLE] }), deps())).reply, {
    content: REPLIES.unknown,
  });
  assert.deepEqual((await handleCommand(command("dance"), deps())).reply, { content: REPLIES.unknown });
});

test("/draw publishes one pixel.draw with a stable batch id and lets the draw worker answer", async () => {
  const d = deps();
  const event = command("draw", { options: { x: 10, y: 20, color: "red" } });
  const out = await handleCommand(event, d);
  assert.equal(out.reply, null);
  assert.equal(d.published.length, 1);
  assert.equal(d.published[0].topic, "pixel.draw");
  assert.deepEqual(d.published[0].payload, {
    batchId: `discord-${event.interaction.id}`,
    user: event.user,
    source: "discord",
    pixels: [{ x: 10, y: 20, color: 0xe50000 }],
    interaction: event.interaction,
  });
});

test("/draw with a bad colour or coordinates answers an error and publishes nothing", async () => {
  for (const options of [{ x: 1, y: 2, color: "rainbow" }, { x: 100000, y: 2, color: "#ffffff" }, { x: -1, y: 0, color: "red" }]) {
    const d = deps();
    const out = await handleCommand(command("draw", { options }), d);
    assert.match(out.reply.content, /❌/);
    assert.equal(d.published.length, 0);
  }
});

test("/get renders the requested square as a PNG, skipping cleared pixels", async () => {
  const store = fakeStore({ session: { paused: false, clearedAt: 42 }, pixels: [{ x: 100, y: 200, c: 0x0000ff }] });
  const d = deps({ store });
  const out = await handleCommand(command("get", { options: { x: 108, y: 208, size: 16 } }), d);
  assert.deepEqual(store.state.regions, [{ x0: 100, y0: 200, size: 16, clearedAt: 42 }]);
  assert.match(out.reply.content, /\(100, 200\) to \(115, 215\), 1 painted pixel/);
  assert.match(out.reply.content, /https:\/\/canvas\.test\//);
  const [file] = out.reply.files;
  assert.equal(file.contentType, "image/png");
  const png = decodePng(file.data);
  // 16 grid pixels scaled x32 to 512 px; (100, 200) is the top-left block.
  assert.equal(png.width, 512);
  assert.deepEqual([...png.rgba.subarray(0, 4)], [0, 0, 255, 255]);
  assert.deepEqual([...png.rgba.subarray(32 * 4, 32 * 4 + 4)], [255, 255, 255, 255]);
});

test("/get says when the area was too busy to read in full", async () => {
  const store = fakeStore({ pixels: [{ x: 100, y: 200, c: 0 }] });
  store.state.truncated = true;
  const out = await handleCommand(command("get", { options: { x: 108, y: 208, size: 16 } }), deps({ store }));
  assert.match(out.reply.content, /1 painted pixel\(s\)\.\n⚠️ This area is too busy/);
});

test("/get defaults to the centre of the grid and clamps to its edges", async () => {
  const store = fakeStore();
  await handleCommand(command("get"), deps({ store }));
  await handleCommand(command("get", { options: { x: 99999, y: 0, size: 2000 } }), deps({ store }));
  assert.deepEqual(store.state.regions[0], { x0: 49936, y0: 49936, size: 128, clearedAt: 0 });
  assert.deepEqual(store.state.regions[1], { x0: 99488, y0: 0, size: 512, clearedAt: 0 });
});

test("/snapshot publishes snapshot.requested once, with a time stable across redeliveries", async () => {
  const d = deps();
  const event = command("snapshot"); // any member, no admin role (subject 3.2)
  assert.deepEqual((await handleCommand(event, d)).reply, { content: REPLIES.snapshot });
  assert.deepEqual((await handleCommand(event, d)).reply, { content: REPLIES.snapshot });
  assert.equal(d.published.length, 1);
  assert.deepEqual(d.published[0].payload, {
    requestId: event.interaction.id,
    requestedBy: event.user.id,
    reason: "command",
    requestedAt: snowflakeTime(event.interaction.id),
    interaction: event.interaction,
    channelId: event.channelId,
  });
});
