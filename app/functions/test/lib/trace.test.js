// End-to-end tracing with an in-memory OpenTelemetry SDK: one brush stroke
// and one /draw each form a single trace, from the incoming request to the
// worker's Firestore and Discord calls, and every log line carries its trace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SpanKind, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { createDrawProxy } from "../../src/pixels/drawProxy.js";
import { createDrawWorker } from "../../src/draw/worker.js";
import { createCommandWorker } from "../../src/commands/worker.js";
import { createInteractionClient } from "../../src/lib/discordWebhook.js";
import { createLogger } from "../../src/lib/logger.js";
import { createPublisher } from "../../src/lib/publisher.js";
import {
  activeTraceIds,
  extractContext,
  firestoreSpan,
  flushSpans,
  injectContext,
  setFlushHook,
  tracedHttp,
  withSpan,
} from "../../src/lib/trace.js";
import { captureLogs } from "./helpers.js";
import { apiRequest, apiResponse } from "../pixels/helpers.js";
import { command, config, fakeStore } from "../commands/helpers.js";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register({ propagator: new W3CTraceContextPropagator() });

const GATEWAY_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const traceparent = `00-${GATEWAY_TRACE}-00f067aa0ba902b7-01`;

/** Publisher on a fake Pub/Sub that hands back what a push subscription would deliver. */
function broker() {
  const messages = [];
  const client = {
    topic: (name) => ({
      publishMessage: async (m) => (messages.push({ topic: name, ...m }), `m${messages.length}`),
    }),
  };
  return {
    messages,
    publisher: (source) => createPublisher({ source, client }),
  };
}

function push(msg) {
  return {
    method: "POST",
    headers: {},
    body: {
      message: {
        data: Buffer.from(JSON.stringify(msg.json)).toString("base64"),
        attributes: msg.attributes,
        messageId: "1",
      },
      deliveryAttempt: 1,
    },
  };
}

const res = () => {
  const r = apiResponse();
  r.send = () => r;
  return r;
};

test("a brush stroke is one trace: gateway -> proxy -> Pub/Sub -> draw worker -> Firestore", async () => {
  exporter.reset();
  const out = captureLogs();
  const logger = createLogger({}, { write: out.write, projectId: "demo" });
  const { messages, publisher } = broker();

  const proxy = tracedHttp(
    "POST /pixels",
    createDrawProxy({
      publisher: publisher("draw-proxy"),
      origins: new Set(),
      logger,
    }),
  );
  await proxy(
    apiRequest({
      body: { batchId: "b-1", pixels: [{ x: 1, y: 2, color: 3 }] },
      headers: { traceparent, "X-Correlation-Id": "corr-trace-1" },
    }),
    res(),
  );

  assert.match(messages[0].attributes.traceparent, new RegExp(`^00-${GATEWAY_TRACE}-[\\da-f]{16}-01$`));

  const store = {
    applyBatch: (b) =>
      firestoreSpan("transaction draw", async () => ({
        duplicate: false,
        accepted: b.pixels,
        rejected: [],
        reason: null,
        quota: null,
      })),
  };
  const worker = createDrawWorker({
    getStore: async () => store,
    publisher: publisher("draw-worker"),
    discord: {},
    logger,
  });
  const r = res();
  await worker(push(messages[0]), r);
  assert.equal(r.statusCode, 204);

  const spans = exporter.getFinishedSpans();
  const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
  assert.deepEqual(
    Object.keys(byName).sort(),
    ["POST /pixels", "firestore transaction draw", "pixel.draw process", "pixel.draw publish", "pixel.processed publish"].sort(),
  );
  // Every span in the gateway's trace, chained parent -> child.
  assert.ok(spans.every((s) => s.spanContext().traceId === GATEWAY_TRACE));
  const parent = (s) => s.parentSpanContext?.spanId ?? s.parentSpanId;
  assert.equal(parent(byName["POST /pixels"]), "00f067aa0ba902b7");
  assert.equal(parent(byName["pixel.draw publish"]), byName["POST /pixels"].spanContext().spanId);
  assert.equal(parent(byName["pixel.draw process"]), byName["pixel.draw publish"].spanContext().spanId);
  assert.equal(parent(byName["firestore transaction draw"]), byName["pixel.draw process"].spanContext().spanId);
  assert.equal(byName["pixel.draw process"].kind, SpanKind.CONSUMER);
  assert.equal(byName["pixel.draw publish"].kind, SpanKind.PRODUCER);
  assert.equal(byName["POST /pixels"].attributes.correlation_id, "corr-trace-1");
  assert.equal(byName["pixel.draw process"].attributes.correlation_id, "corr-trace-1");

  // Logs of both functions: same correlation id, same trace, attached to it.
  for (const line of out.lines) {
    assert.equal(line.correlation_id, "corr-trace-1");
    assert.equal(line.trace_id, GATEWAY_TRACE);
    assert.equal(line["logging.googleapis.com/trace"], `projects/demo/traces/${GATEWAY_TRACE}`);
    assert.equal(line["logging.googleapis.com/trace_sampled"], true);
  }
  assert.ok(out.lines.some((l) => l.message === "batch applied"));
});

test("a /draw is one trace: command worker -> pixel.draw -> draw worker -> Discord", async () => {
  exporter.reset();
  const { messages, publisher } = broker();
  const logger = createLogger({}, { write: () => {} });
  const discordCalls = [];
  const discord = createInteractionClient({
    fetch: async (url, init) => (discordCalls.push(init.method), new Response("{}", { status: 200 })),
  });

  // The proxy's message, as Pub/Sub delivers it (traceparent of the proxy span).
  await withSpan("POST /discord/interactions", { kind: SpanKind.SERVER, parent: extractContext({ traceparent }) }, () =>
    publisher("discord-proxy").publish("discord.command", command("draw", { options: { x: 1, y: 1, color: "red" } }), {
      correlationId: "corr-trace-2",
    }),
  );
  await createCommandWorker({
    getStore: async () => fakeStore(),
    publisher: publisher("command-worker"),
    discord,
    config,
    logger,
  })(push(messages[0]), res());
  const store = {
    applyBatch: async (b) => ({
      duplicate: false,
      accepted: b.pixels,
      rejected: [],
      reason: null,
      quota: null,
    }),
  };
  await createDrawWorker({
    getStore: async () => store,
    publisher: publisher("draw-worker"),
    discord,
    logger,
  })(push(messages[1]), res());

  const spans = exporter.getFinishedSpans();
  assert.ok(
    spans.every((s) => s.spanContext().traceId === GATEWAY_TRACE),
    spans.map((s) => s.name).join(),
  );
  assert.deepEqual(
    spans.map((s) => s.name).sort(),
    [
      "POST /discord/interactions",
      "discord PATCH webhook",
      "discord.command process",
      "discord.command publish",
      "pixel.draw process",
      "pixel.draw publish",
      "pixel.processed publish",
    ].sort(),
  );
  assert.deepEqual(discordCalls, ["PATCH"]);
  const discordSpan = spans.find((s) => s.name === "discord PATCH webhook");
  assert.equal(discordSpan.attributes["http.response.status_code"], 200);
  // The interaction token never reaches a span.
  assert.ok(!JSON.stringify(spans.map((s) => s.attributes)).includes("tok"));
});

test("a failing worker records the exception on its span", async () => {
  exporter.reset();
  const { messages, publisher } = broker();
  await publisher("x").publish("pixel.draw", {
    batchId: "b",
    user: { id: "123456", name: "a" },
    source: "web",
    pixels: [{ x: 0, y: 0, color: 0 }],
  });
  const store = {
    applyBatch: async () => Promise.reject(new Error("firestore down")),
  };
  const r = res();
  await createDrawWorker({
    getStore: async () => store,
    publisher: publisher("y"),
    discord: {},
    logger: createLogger({}, { write: () => {} }),
  })(push(messages[0]), r);
  assert.equal(r.statusCode, 500);
  const span = exporter.getFinishedSpans().find((s) => s.name === "pixel.draw process");
  assert.equal(span.status.code, 2);
  assert.equal(span.events[0].name, "exception");
});

test("helpers: ids of the active span, inject/extract, flush hook never throws", async () => {
  assert.deepEqual(activeTraceIds(), {});
  await withSpan("outer", {}, async () => {
    const ids = activeTraceIds();
    assert.match(ids.traceId, /^[\da-f]{32}$/);
    const carrier = injectContext({});
    assert.equal(trace.getSpanContext(extractContext({ TraceParent: carrier.traceparent })).traceId, ids.traceId);
  });
  await assert.rejects(
    withSpan("boom", {}, async () => Promise.reject(new TypeError("x"))),
    TypeError,
  );
  let flushed = 0;
  setFlushHook(async () => flushed++);
  await flushSpans();
  setFlushHook(async () => Promise.reject(new Error("exporter down")));
  await flushSpans();
  setFlushHook(async () => {});
  assert.equal(flushed, 1);
});

test("the SERVER span is exported before the response leaves, later spans when the handler returns", async () => {
  exporter.reset();
  const order = [];
  setFlushHook(async () => order.push(`flush:${exporter.getFinishedSpans().map((s) => s.name).join(",")}`));
  const r = {
    statusCode: 0,
    headers: {},
    end(body) {
      order.push(`end:${body}`);
      return r;
    },
  };
  await tracedHttp("POST /interactions", async (req, res) => {
    res.statusCode = 200;
    res.end("deferred");
    await withSpan("after the answer", {}, async () => {});
  })({ method: "POST", headers: { traceparent } }, r);
  assert.deepEqual(order, ["flush:POST /interactions", "end:deferred", "flush:POST /interactions,after the answer"]);
  assert.equal(r.end.name, "end");
  const [server] = exporter.getFinishedSpans();
  assert.equal(server.attributes["http.response.status_code"], 200);
  setFlushHook(async () => {});
});

test("a handler that throws without answering still ends and exports its span", async () => {
  exporter.reset();
  let flushed = 0;
  setFlushHook(async () => flushed++);
  const r = { statusCode: 0, headers: {}, end: () => r };
  const realEnd = r.end;
  await assert.rejects(
    tracedHttp("GET /boom", async () => {
      throw new TypeError("boom");
    })({ method: "GET", headers: {} }, r),
    TypeError,
  );
  assert.equal(flushed, 1);
  assert.equal(r.end, realEnd);
  assert.equal(exporter.getFinishedSpans()[0].status.code, 2);
  setFlushHook(async () => {});
});

test("entry points wait for the SDK start, and a failed start never blocks them", async () => {
  const { setTracingReady, tracingReady } = await import("../../src/lib/trace.js");
  let started = false;
  setTracingReady(new Promise((r) => setTimeout(() => ((started = true), r()), 20)));
  let sawStarted;
  await tracedHttp("GET /x", async (req, res) => {
    sawStarted = started;
    res.statusCode = 200;
  })({ method: "GET", headers: {} }, { statusCode: 0, headers: {} });
  assert.equal(sawStarted, true);
  setTracingReady(Promise.reject(new Error("no credentials")));
  await tracingReady();
  setTracingReady(undefined);
});
