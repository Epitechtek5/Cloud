// OpenTelemetry bootstrap hook.
//
// The tracing issue fills this in (SDK, exporter to Cloud Trace). Functions
// already call initTracing() once at load time, so enabling tracing later does
// not touch any function.

let hook;
let initialized;

/** Registers the bootstrap to run (called by the tracing module). */
export function registerTracingHook(fn) {
  hook = fn;
  initialized = undefined;
}

/** Runs the registered bootstrap once per instance; a no-op until one is registered. */
export function initTracing(context = {}) {
  if (!hook) return undefined;
  initialized ??= hook(context);
  return initialized;
}
