// Minimal structured logger and correlation id helper.
// Placeholder until the shared runtime library (#61) lands: same field names
// (function, event_type, correlation_id, user_id) so swapping it is a one-line
// import change. One JSON object per line on stdout is what Cloud Logging
// parses into a structured entry (severity and message are recognised).

const CORRELATION_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Returns the caller's X-Correlation-Id when it is well formed, otherwise a new
 * one. The format check keeps arbitrary text (newlines, very long values) out
 * of the logs.
 */
export function correlationIdFrom(req) {
  const value = req.get?.("x-correlation-id") ?? req.headers?.["x-correlation-id"];
  return typeof value === "string" && CORRELATION_ID.test(value) ? value : crypto.randomUUID();
}

/**
 * @param {object} base fields added to every entry (function, correlation_id)
 * @param {(line: string) => void} [write] sink, stdout by default (tests inject one)
 */
export function createLogger(base, write = (line) => process.stdout.write(`${line}\n`)) {
  const emit = (severity, eventType, message, fields = {}) =>
    write(JSON.stringify({ severity, message, event_type: eventType, ...base, ...fields }));
  return {
    info: (eventType, message, fields) => emit("INFO", eventType, message, fields),
    warn: (eventType, message, fields) => emit("WARNING", eventType, message, fields),
    error: (eventType, message, fields) => emit("ERROR", eventType, message, fields),
  };
}
