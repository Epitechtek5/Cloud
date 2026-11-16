import { test } from "node:test";
import assert from "node:assert/strict";
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { startOtel, tracingEnabled } from "../../src/lib/otel.js";
import { extractContext, flushSpans, withSpan } from "../../src/lib/trace.js";

test("enabled on Cloud Run only, and can be switched off", () => {
  assert.equal(tracingEnabled({}), false);
  assert.equal(tracingEnabled({ K_SERVICE: "draw-worker" }), true);
  assert.equal(tracingEnabled({ K_SERVICE: "draw-worker", OTEL_SDK_DISABLED: "true" }), false);
});

test("the SDK exports spans with the function name, flushes on demand, and keeps children of unsampled parents", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = await startOtel({
    env: { FUNCTION_NAME: "draw-worker" },
    exporter,
  });
  try {
    await withSpan("root", {}, async () => {});
    // Cloud Run often forwards an unsampled parent (flag 00): still traced with ratio 1.
    await withSpan(
      "child",
      {
        parent: extractContext({
          "X-Cloud-Trace-Context": "4bf92f3577b34da6a3ce929d0e0e4736/1;o=0",
        }),
      },
      async () => {},
    );
    await flushSpans();
    const spans = exporter.getFinishedSpans();
    assert.deepEqual(
      spans.map((s) => s.name),
      ["root", "child"],
    );
    assert.equal(spans[1].spanContext().traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
    assert.equal(spans[0].resource.attributes["service.name"], "draw-worker");
    assert.ok(trace.getTracerProvider());
  } finally {
    await provider.shutdown();
  }
});
