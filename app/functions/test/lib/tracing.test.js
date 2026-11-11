import { test } from "node:test";
import assert from "node:assert/strict";
import { initTracing, registerTracingHook } from "../../src/lib/tracing.js";

test("initTracing is a no-op until a hook is registered, then runs it once", () => {
  assert.equal(initTracing(), undefined);
  let calls = 0;
  registerTracingHook((ctx) => (calls++, `sdk:${ctx.service}`));
  assert.equal(initTracing({ service: "a" }), "sdk:a");
  assert.equal(initTracing({ service: "b" }), "sdk:a");
  assert.equal(calls, 1);
});

test("the library entry point exports every helper", async () => {
  const lib = await import("../../src/lib/index.js");
  for (const name of [
    "createLogger",
    "createPublisher",
    "createSecretReader",
    "decodePushMessage",
    "httpContext",
    "messageContext",
    "validateEvent",
    "initTracing",
    "correlationFromHeaders",
  ])
    assert.equal(typeof lib[name], "function", name);
});
