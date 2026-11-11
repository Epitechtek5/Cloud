import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublisher } from "../../src/lib/publisher.js";
import { EventValidationError } from "../../src/lib/events.js";
import { valid } from "./fixtures.js";

function fakePubSub() {
  const published = [];
  const topics = [];
  return {
    published,
    topics,
    topic(name) {
      topics.push(name);
      return { publishMessage: async (msg) => (published.push({ topic: name, ...msg }), `m${published.length}`) };
    },
  };
}

test("publishes JSON with correlation_id, event_type and source attributes", async () => {
  const client = fakePubSub();
  const publisher = createPublisher({ source: "draw-proxy", client });
  const result = await publisher.publish("pixel.draw", valid["pixel.draw"], {
    correlationId: "corr-1234",
    attributes: { extra: "1", correlation_id: "overridden" },
  });
  assert.deepEqual(result, { messageId: "m1", correlationId: "corr-1234" });
  assert.deepEqual(client.published[0], {
    topic: "pixel.draw",
    json: valid["pixel.draw"],
    attributes: { extra: "1", correlation_id: "corr-1234", event_type: "pixel.draw", source: "draw-proxy" },
  });
});

test("generates a correlation id when none is given and reuses topic handles", async () => {
  const client = fakePubSub();
  const publisher = createPublisher({ source: "s", client, topics: { "pixel.draw": "custom-topic" } });
  const a = await publisher.publish("pixel.draw", valid["pixel.draw"]);
  await publisher.publish("pixel.draw", valid["pixel.draw"]);
  assert.match(a.correlationId, /^[\da-f-]{36}$/);
  assert.deepEqual(client.topics, ["custom-topic"]);
});

test("refuses an invalid payload before calling Pub/Sub", async () => {
  const client = fakePubSub();
  const publisher = createPublisher({ source: "s", client });
  await assert.rejects(publisher.publish("pixel.draw", { pixels: [] }), EventValidationError);
  assert.equal(client.published.length, 0);
});

test("needs a source", () => {
  assert.throws(() => createPublisher({}), /source/);
});
