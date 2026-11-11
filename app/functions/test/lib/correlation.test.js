import { test } from "node:test";
import assert from "node:assert/strict";
import {
  correlationFromAttributes,
  correlationFromHeaders,
  isValidCorrelationId,
  traceFromHeaders,
} from "../../src/lib/correlation.js";

const UUID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

test("keeps a valid X-Correlation-Id, whatever the header case", () => {
  const id = "3f1c2b8e-1d2a-4f5b-9c0d-112233445566";
  assert.equal(correlationFromHeaders({ "X-Correlation-Id": id }), id);
  assert.equal(correlationFromHeaders({ "x-correlation-id": [id] }), id);
  assert.equal(correlationFromHeaders(new Headers({ "x-correlation-id": id })), id);
});

test("generates a uuid when the header is missing or unsafe", () => {
  assert.match(correlationFromHeaders({}), UUID);
  assert.match(correlationFromHeaders(undefined), UUID);
  assert.match(correlationFromHeaders({ "x-correlation-id": "bad id\nINJECTED" }), UUID);
  assert.match(correlationFromHeaders({ "x-correlation-id": "x".repeat(500) }), UUID);
});

test("reads the correlation id of a message", () => {
  assert.equal(correlationFromAttributes({ correlation_id: "abcdefgh-1234" }), "abcdefgh-1234");
  assert.match(correlationFromAttributes({}), UUID);
  assert.match(correlationFromAttributes(undefined), UUID);
});

test("validates correlation ids", () => {
  assert.equal(isValidCorrelationId("01HZX3J5K7M9N1P3Q5R7S9T1V3"), true);
  assert.equal(isValidCorrelationId("short"), false);
  assert.equal(isValidCorrelationId(42), false);
});

test("parses W3C traceparent", () => {
  const t = traceFromHeaders({ traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" });
  assert.deepEqual(t, { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true });
  assert.deepEqual(traceFromHeaders({ traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01" }), {});
});

test("parses X-Cloud-Trace-Context", () => {
  const t = traceFromHeaders({ "x-cloud-trace-context": "105445aa7843bc8bf206b12000100000/1;o=1" });
  assert.deepEqual(t, { traceId: "105445aa7843bc8bf206b12000100000", spanId: "0000000000000001", sampled: true });
  assert.deepEqual(traceFromHeaders({ "x-cloud-trace-context": "105445aa7843bc8bf206b12000100000" }), {
    traceId: "105445aa7843bc8bf206b12000100000",
    spanId: undefined,
    sampled: false,
  });
  assert.deepEqual(traceFromHeaders({ "x-cloud-trace-context": "garbage" }), {});
});
