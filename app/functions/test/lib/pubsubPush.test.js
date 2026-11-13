import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePushMessage, InvalidPushError } from "../../src/lib/pubsubPush.js";
import { EventValidationError } from "../../src/lib/events.js";
import { valid } from "./fixtures.js";

const body = (payload, attributes) => ({
  message: {
    data: Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)).toString("base64"),
    attributes,
    messageId: "42",
  },
  subscription: "projects/p/subscriptions/pixel.draw.sub",
  deliveryAttempt: 2,
});

test("decodes a push message and keeps its correlation id", () => {
  const decoded = decodePushMessage(
    body(valid["pixel.draw"], { event_type: "pixel.draw", correlation_id: "corr-1234", source: "draw-proxy" }),
  );
  assert.equal(decoded.eventType, "pixel.draw");
  assert.equal(decoded.correlationId, "corr-1234");
  assert.equal(decoded.messageId, "42");
  assert.equal(decoded.deliveryAttempt, 2);
  assert.deepEqual(decoded.payload, valid["pixel.draw"]);
});

test("rejects malformed push bodies", () => {
  assert.throws(() => decodePushMessage({}), InvalidPushError);
  assert.throws(() => decodePushMessage(body(valid["pixel.draw"], {})), /event_type/);
  assert.throws(() => decodePushMessage(body("{not json", { event_type: "pixel.draw" })), /not JSON/);
  assert.throws(() => decodePushMessage(body({}, { event_type: "pixel.draw" })), EventValidationError);
});

test("refuses an event type the worker does not handle", () => {
  const draw = body(valid["pixel.draw"], { event_type: "pixel.draw" });
  assert.equal(decodePushMessage(draw, { expect: "pixel.draw" }).eventType, "pixel.draw");
  assert.equal(decodePushMessage(draw, { expect: ["pixel.draw", "discord.command"] }).eventType, "pixel.draw");
  assert.throws(() => decodePushMessage(draw, { expect: "discord.command" }), /unexpected event_type pixel.draw/);
});
