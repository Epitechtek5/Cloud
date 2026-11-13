import { test } from "node:test";
import assert from "node:assert/strict";
import { assertEvent, EVENT_TYPES, EventValidationError, SCHEMAS, validateEvent } from "../../src/lib/events.js";
import { valid } from "./fixtures.js";

test("every event type has a schema and a valid fixture", () => {
  assert.deepEqual(Object.keys(SCHEMAS).sort(), [...EVENT_TYPES].sort());
  for (const type of EVENT_TYPES) assert.deepEqual(validateEvent(type, valid[type]), { ok: true }, type);
});

test("rejects an unknown event type", () => {
  assert.deepEqual(validateEvent("nope", {}), { ok: false, errors: ["unknown event type nope"] });
});

const invalid = [
  ["pixel.draw", { ...valid["pixel.draw"], pixels: [] }, "payload.pixels must have 1 to 256 items"],
  ["pixel.draw", { ...valid["pixel.draw"], pixels: Array(257).fill({ x: 0, y: 0, color: 0 }) }, "1 to 256 items"],
  ["pixel.draw", { ...valid["pixel.draw"], pixels: [{ x: 100000, y: 0, color: 0 }] }, "payload.pixels[0].x must be between 0 and 99999"],
  ["pixel.draw", { ...valid["pixel.draw"], pixels: [{ x: 1.5, y: 0, color: 0 }] }, "must be an integer"],
  ["pixel.draw", { ...valid["pixel.draw"], pixels: [{ x: 0, y: 0, color: 0x1000000 }] }, "color must be between"],
  ["pixel.draw", { ...valid["pixel.draw"], source: "cli" }, "payload.source must be one of web, discord"],
  ["pixel.draw", { ...valid["pixel.draw"], batchId: "" }, "payload.batchId must be 1 to 256 characters"],
  ["pixel.draw", { ...valid["pixel.draw"], batchId: "a b" }, "payload.batchId has an invalid format"],
  ["pixel.draw", { ...valid["pixel.draw"], user: { id: 42 } }, "payload.user.id must be a string"],
  ["pixel.draw", { ...valid["pixel.draw"], extra: 1 }, "payload.extra is not allowed"],
  ["pixel.draw", { ...valid["pixel.draw"], pixels: "x" }, "payload.pixels must be an array"],
  ["pixel.draw", null, "payload must not be null"],
  ["pixel.draw", [], "payload must be an object"],
  ["pixel.draw", undefined, "payload is required"],
  ["discord.command", { ...valid["discord.command"], options: [] }, "payload.options must be an object"],
  ["discord.command", { ...valid["discord.command"], command: undefined }, "payload.command is required"],
  ["discord.command", { ...valid["discord.command"], guildId: "abc" }, "payload.guildId has an invalid format"],
  ["pixel.processed", { ...valid["pixel.processed"], pixels: [{ x: 1, y: 1, color: -1 }] }, "color must be between 0"],
  ["pixel.processed", { ...valid["pixel.processed"], pixels: Array(257).fill({ x: 0, y: 0, color: 0 }) }, "0 to 256 items"],
  ["pixel.processed", { ...valid["pixel.processed"], cleared: "yes" }, "payload.cleared must be a boolean"],
  ["snapshot.requested", { ...valid["snapshot.requested"], reason: "cron" }, "payload.reason must be one of"],
];

for (const [type, payload, expected] of invalid) {
  test(`${type}: ${expected}`, () => {
    const result = validateEvent(type, payload);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes(expected)), result.errors.join(" | "));
  });
}

test("optional and nullable fields may be left out", () => {
  const { subcommand, guildId, channelId, memberPermissions, ...rest } = valid["discord.command"];
  void subcommand, guildId, channelId, memberPermissions;
  assert.deepEqual(validateEvent("discord.command", rest), { ok: true });
  const { rejected, ...processed } = valid["pixel.processed"];
  void rejected;
  assert.deepEqual(validateEvent("pixel.processed", processed), { ok: true });
});

test("assertEvent returns the payload or throws EventValidationError", () => {
  assert.equal(assertEvent("pixel.draw", valid["pixel.draw"]), valid["pixel.draw"]);
  assert.throws(
    () => assertEvent("pixel.draw", {}),
    (err) => err instanceof EventValidationError && err.eventType === "pixel.draw" && err.errors.length > 0,
  );
});

test("pixel.processed carries an /admin clear as a signal, not as per-pixel deltas", () => {
  const clear = { batchId: "clear-1", userId: valid["pixel.processed"].userId, cleared: true, pixels: [] };
  assert.deepEqual(validateEvent("pixel.processed", clear), { ok: true });
});

test("prototype keys are not schema fields", () => {
  for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    const payload = JSON.parse(JSON.stringify(valid["pixel.draw"]).replace(/^\{/, `{"${key}":1,`));
    const result = validateEvent("pixel.draw", payload);
    assert.equal(result.ok, false, key);
    assert.ok(result.errors.includes(`payload.${key} is not allowed`), result.errors.join(" | "));
  }
});
