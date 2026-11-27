// Per-invocation context: correlation id, trace and a logger bound to both.
import { correlationFromAttributes, correlationFromHeaders, traceFromHeaders } from "./correlation.js";
import { createLogger } from "./logger.js";
import { activeTraceIds } from "./trace.js";

// The active span (tracing on) wins over the incoming headers: the log lines
// are then attached to the span that produced them.
function traceIds(headers) {
  const active = activeTraceIds();
  return active.traceId ? active : traceFromHeaders(headers);
}

/** For an HTTP entry point (proxy): correlation id from `X-Correlation-Id` or a new one. */
export function httpContext(req, { functionName, logger } = {}) {
  const correlationId = correlationFromHeaders(req.headers);
  const { traceId, spanId, sampled } = traceIds(req.headers);
  const base = logger ?? createLogger({ function: functionName });
  return { correlationId, traceId, log: base.child({ correlationId, traceId, spanId, traceSampled: sampled }) };
}

/** For a worker: correlation id and event type from the Pub/Sub message attributes. */
export function messageContext(attributes = {}, { functionName, logger, headers } = {}) {
  const correlationId = correlationFromAttributes(attributes);
  const { traceId, spanId, sampled } = traceIds(headers);
  const base = logger ?? createLogger({ function: functionName });
  return {
    correlationId,
    traceId,
    log: base.child({ correlationId, eventType: attributes.event_type, traceId, spanId, traceSampled: sampled }),
  };
}
