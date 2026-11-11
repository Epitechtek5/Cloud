import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../../src/lib/logger.js";
import { captureLogs } from "./helpers.js";

test("emits Cloud Logging JSON with the platform fields", () => {
  const out = captureLogs();
  const log = createLogger({ function: "draw-proxy" }, { projectId: "p1", write: out.write });
  log.child({ correlationId: "c-12345678", eventType: "pixel.draw", traceId: "abc", spanId: "def", userId: "42" }).info(
    "published",
    { batchId: "b1" },
  );
  assert.deepEqual(out.lines[0], {
    severity: "INFO",
    message: "published",
    function: "draw-proxy",
    correlation_id: "c-12345678",
    event_type: "pixel.draw",
    trace_id: "abc",
    span_id: "def",
    user_id: "42",
    batchId: "b1",
    "logging.googleapis.com/trace": "projects/p1/traces/abc",
    "logging.googleapis.com/spanId": "def",
  });
});

test("no trace link without a project or a trace id", () => {
  const out = captureLogs();
  createLogger({ traceId: "abc" }, { projectId: undefined, write: out.write }).info("x");
  createLogger({}, { projectId: "p1", write: out.write }).info("y");
  for (const line of out.lines) assert.equal(line["logging.googleapis.com/trace"], undefined);
});

test("maps every severity, filters below the level, serializes errors", () => {
  const out = captureLogs();
  const log = createLogger({}, { write: out.write, level: "info" });
  log.debug("hidden");
  log.info("i");
  log.notice("n");
  log.warn("w");
  log.error("e", { err: new TypeError("boom"), skipped: undefined });
  assert.deepEqual(
    out.lines.map((l) => l.severity),
    ["INFO", "NOTICE", "WARNING", "ERROR"],
  );
  assert.equal(out.lines[3].err.name, "TypeError");
  assert.equal(out.lines[3].err.message, "boom");
  assert.equal("skipped" in out.lines[3], false);
});

test("child keeps the level and the sink", () => {
  const out = captureLogs();
  const log = createLogger({ function: "f" }, { write: out.write, level: "WARNING" }).child({ userId: "1" });
  log.info("hidden");
  log.warn("shown");
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0].user_id, "1");
  assert.equal(out.lines[0].function, "f");
});

test("default sink writes one line on stdout (stderr for errors)", (t) => {
  const stdout = t.mock.method(process.stdout, "write", () => true);
  const stderr = t.mock.method(process.stderr, "write", () => true);
  const log = createLogger({ function: "f" });
  log.info("out");
  log.error("err");
  assert.equal(JSON.parse(stdout.mock.calls[0].arguments[0]).message, "out");
  assert.equal(JSON.parse(stderr.mock.calls[0].arguments[0]).message, "err");
});
