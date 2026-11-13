// Structured JSON logs understood by Cloud Logging.
//
// Cloud Run functions forward every stdout/stderr line to Cloud Logging and
// parse it as JSON: `severity` and `message` become the entry's severity and
// summary, `logging.googleapis.com/trace` attaches the entry to its trace, and
// every other field lands in `jsonPayload`.

const SEVERITIES = ["DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL"];
// Common spellings of LOG_LEVEL that are not Cloud Logging severities.
const LEVEL_ALIASES = { WARN: "WARNING", ERR: "ERROR", FATAL: "CRITICAL" };

/** Minimum severity index for a LOG_LEVEL value; an unknown value falls back to INFO. */
function levelIndex(level) {
  const name = String(level).trim().toUpperCase();
  const index = SEVERITIES.indexOf(LEVEL_ALIASES[name] ?? name);
  return index === -1 ? SEVERITIES.indexOf("INFO") : index;
}

// Fields known by the platform conventions (C05 §6): renamed to snake_case.
const FIELD_NAMES = {
  function: "function",
  eventType: "event_type",
  correlationId: "correlation_id",
  traceId: "trace_id",
  spanId: "span_id",
  userId: "user_id",
};

function normalize(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined) continue;
    out[FIELD_NAMES[key] ?? key] = value instanceof Error ? serializeError(value) : value;
  }
  return out;
}

function serializeError(error) {
  return { name: error.name, message: error.message, stack: error.stack };
}

/**
 * @param {object} context  bound fields: function, eventType, correlationId, traceId, spanId, userId, ...
 * @param {object} [options]
 * @param {string} [options.projectId]  needed to build the trace resource name (env GOOGLE_CLOUD_PROJECT by default)
 * @param {(line: string, severity: string) => void} [options.write]  sink, stdout/stderr by default
 * @param {string} [options.level]  minimum severity (env LOG_LEVEL, INFO by default)
 */
export function createLogger(context = {}, options = {}) {
  const projectId = options.projectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCP_PROJECT;
  const write = options.write ?? defaultWrite;
  const level = options.level ?? process.env.LOG_LEVEL ?? "INFO";
  const minIndex = levelIndex(level);
  const bound = normalize(context);

  function log(severity, message, fields) {
    if (SEVERITIES.indexOf(severity) < minIndex) return;
    // severity and message last: fields cannot override them.
    const entry = { ...bound, ...normalize(fields), severity, message: String(message) };
    if (entry.trace_id && projectId) {
      entry["logging.googleapis.com/trace"] = `projects/${projectId}/traces/${entry.trace_id}`;
      if (entry.span_id) entry["logging.googleapis.com/spanId"] = entry.span_id;
    }
    write(JSON.stringify(entry), severity);
  }

  return {
    debug: (message, fields) => log("DEBUG", message, fields),
    info: (message, fields) => log("INFO", message, fields),
    notice: (message, fields) => log("NOTICE", message, fields),
    warn: (message, fields) => log("WARNING", message, fields),
    error: (message, fields) => log("ERROR", message, fields),
    /** A logger with more bound fields (e.g. the correlation id of one request). */
    child: (fields) => createLogger({ ...context, ...fields }, { ...options, projectId, write, level }),
  };
}

function defaultWrite(line, severity) {
  const stream = SEVERITIES.indexOf(severity) >= SEVERITIES.indexOf("ERROR") ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}
