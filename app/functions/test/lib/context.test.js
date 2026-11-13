import { test } from "node:test";
import assert from "node:assert/strict";
import { httpContext, messageContext } from "../../src/lib/context.js";
import { createLogger } from "../../src/lib/logger.js";
import { createPublisher } from "../../src/lib/publisher.js";
import { decodePushMessage } from "../../src/lib/pubsubPush.js";
import { captureLogs } from "./helpers.js";
import { valid } from "./fixtures.js";

test("a correlation id set in a proxy is visible in the worker logs", async () => {
  const out = captureLogs();
  const logger = (name) => createLogger({ function: name }, { projectId: "p", write: out.write });

  // Proxy: takes the client's id, logs it and publishes it as an attribute.
  const proxy = httpContext(
    {
      headers: {
        "x-correlation-id": "client-corr-0001",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    },
    { logger: logger("draw-proxy") },
  );
  proxy.log.info("accepted");
  let sent;
  const client = { topic: () => ({ publishMessage: async (m) => ((sent = m), "1") }) };
  await createPublisher({ source: "draw-proxy", client }).publish("pixel.draw", valid["pixel.draw"], {
    correlationId: proxy.correlationId,
  });

  // Worker: receives the push and re-emits the same id.
  const push = decodePushMessage({
    message: { data: Buffer.from(JSON.stringify(sent.json)).toString("base64"), attributes: sent.attributes },
  });
  const worker = messageContext(push.attributes, { logger: logger("draw-worker") });
  worker.log.info("processed");

  assert.deepEqual(
    out.lines.map((l) => [l.function, l.correlation_id]),
    [
      ["draw-proxy", "client-corr-0001"],
      ["draw-worker", "client-corr-0001"],
    ],
  );
  assert.equal(out.lines[0]["logging.googleapis.com/trace"], "projects/p/traces/4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(out.lines[1].event_type, "pixel.draw");
});

test("contexts create their own logger when none is given", (t) => {
  const stdout = t.mock.method(process.stdout, "write", () => true);
  httpContext({ headers: {} }, { functionName: "p" }).log.info("a");
  messageContext(undefined, { functionName: "w" }).log.info("b");
  const lines = stdout.mock.calls.map((c) => JSON.parse(c.arguments[0]));
  assert.deepEqual(
    lines.map((l) => l.function),
    ["p", "w"],
  );
  assert.ok(lines.every((l) => l.correlation_id));
});
