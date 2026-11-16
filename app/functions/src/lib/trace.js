// Spans and trace context, on the OpenTelemetry API only: without the SDK
// (unit tests, local runs) every call is a cheap no-op. The SDK and the Cloud
// Trace exporter are started by otel.js (initTracing in src/index.js).
//
// One request = one trace (subject 04, C08 §6):
//   gateway --traceparent--> proxy span --publish (traceparent attribute)-->
//   Pub/Sub --> worker span (child of the proxy span) --> Firestore / Discord / GCS spans
import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

export { SpanKind };

const tracer = () => trace.getTracer("pixel-canvas");

// Start of the SDK (async import): entry points wait for it so that the
// first request of a cold instance is traced too. Never rejects.
let ready = Promise.resolve();
export function setTracingReady(promise) {
  ready = Promise.resolve(promise).catch(() => {});
}
export function tracingReady() {
  return ready;
}

// Hook of the SDK to export the finished spans before a worker acks its
// message (the instance may lose its CPU once the response is sent).
let flushHook = async () => {};
export function setFlushHook(fn) {
  flushHook = fn;
}
export async function flushSpans() {
  try {
    await flushHook();
  } catch {
    // Tracing must never fail a request.
  }
}

/**
 * Runs fn(span) inside a new span, child of `parent` (a context) or of the
 * active span. The span records an exception and ends in every case.
 */
export async function withSpan(name, { kind = SpanKind.INTERNAL, attributes = {}, parent } = {}, fn) {
  const ctx = parent ?? context.active();
  const span = tracer().startSpan(name, { kind, attributes }, ctx);
  try {
    return await context.with(trace.setSpan(ctx, span), () => fn(span));
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err?.name });
    throw err;
  } finally {
    span.end();
  }
}

/** A span around a Firestore call (CLIENT, db.system firestore). */
export function firestoreSpan(operation, fn) {
  return withSpan(
    `firestore ${operation}`,
    {
      kind: SpanKind.CLIENT,
      attributes: { "db.system": "firestore", "db.operation.name": operation },
    },
    fn,
  );
}

/**
 * Wraps an HTTP entry point in a SERVER span, child of the caller's trace
 * (traceparent or X-Cloud-Trace-Context sent by the gateway / Cloud Run), and
 * exports the spans once the handler is done.
 */
export function tracedHttp(name, handler) {
  return async function traced(req, res) {
    await ready;
    await withSpan(
      name,
      {
        kind: SpanKind.SERVER,
        parent: extractContext(req.headers),
        attributes: { "http.request.method": req.method },
      },
      async (span) => {
        await handler(req, res);
        if (res.statusCode) span.setAttribute("http.response.status_code", res.statusCode);
        const correlationId = res.get?.("X-Correlation-Id") ?? res.headers?.["X-Correlation-Id"];
        if (correlationId) span.setAttribute("correlation_id", correlationId);
      },
    );
    await flushSpans();
  };
}

/** Trace context of an incoming carrier (HTTP headers or Pub/Sub attributes). */
export function extractContext(carrier = {}) {
  const lower = Object.fromEntries(Object.entries(carrier ?? {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
  return propagation.extract(ROOT_CONTEXT, lower);
}

/** The active trace context as string attributes (`traceparent`, `tracestate`), for a Pub/Sub message. */
export function injectContext(carrier = {}) {
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** `{ traceId, spanId, sampled }` of the active span, or {} when there is none. */
export function activeTraceIds() {
  const sc = trace.getActiveSpan()?.spanContext();
  if (!sc || !trace.isSpanContextValid(sc)) return {};
  return {
    traceId: sc.traceId,
    spanId: sc.spanId,
    sampled: (sc.traceFlags & 1) === 1,
  };
}
