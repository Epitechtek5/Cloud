// Correlation and trace ids.
//
// The correlation id is created by the public entry point (proxy) or taken
// from the `X-Correlation-Id` header, then carried as the `correlation_id`
// attribute of every Pub/Sub message so that workers can re-emit it.
import { randomUUID } from "node:crypto";

export const CORRELATION_HEADER = "x-correlation-id";
export const CORRELATION_ATTRIBUTE = "correlation_id";

// Accept what a client may reasonably send (uuid, ulid, short tokens), refuse
// anything that could pollute the logs (spaces, control chars, huge values).
const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function newCorrelationId() {
  return randomUUID();
}

export function isValidCorrelationId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

function header(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key];
  return Array.isArray(value) ? value[0] : value;
}

/** Correlation id of an incoming HTTP request: the client's one if valid, a new one otherwise. */
export function correlationFromHeaders(headers) {
  const value = header(headers, CORRELATION_HEADER);
  return isValidCorrelationId(value) ? value : newCorrelationId();
}

/** Correlation id of a Pub/Sub message (attributes), a new one if missing or invalid. */
export function correlationFromAttributes(attributes) {
  const value = attributes?.[CORRELATION_ATTRIBUTE];
  return isValidCorrelationId(value) ? value : newCorrelationId();
}

/**
 * Trace context of an incoming request, from W3C `traceparent` or Google's
 * `X-Cloud-Trace-Context` (`TRACE_ID/SPAN_ID;o=1`). Returns `{}` when absent.
 */
export function traceFromHeaders(headers) {
  const traceparent = header(headers, "traceparent");
  const w3c = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/.exec(traceparent ?? "");
  if (w3c && !/^0+$/.test(w3c[1])) {
    return { traceId: w3c[1], spanId: w3c[2], sampled: (parseInt(w3c[3], 16) & 1) === 1 };
  }
  const cloud = /^([\da-f]{32})(?:\/(\d+))?(?:;o=([01]))?$/.exec(header(headers, "x-cloud-trace-context") ?? "");
  if (cloud) {
    const spanId = cloud[2] === undefined ? undefined : BigInt(cloud[2]).toString(16).padStart(16, "0");
    return { traceId: cloud[1], spanId, sampled: cloud[3] === "1" };
  }
  return {};
}
