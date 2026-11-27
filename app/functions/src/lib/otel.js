// OpenTelemetry SDK of a function instance (#74): Cloud Trace exporter, W3C
// and X-Cloud-Trace-Context propagation, registered once by initTracing().
// Enabled on Cloud Run (K_SERVICE is set) unless OTEL_SDK_DISABLED=true.
//
// Sampling: every new trace and every child of a sampled parent are kept; a
// child of an unsampled parent (Cloud Run samples few requests) is kept with
// TRACE_SAMPLE_RATIO (1 by default), so that a /draw or a brush stroke can
// always be followed end to end during the demo.
import { setFlushHook } from "./trace.js";

export function tracingEnabled(env = process.env) {
  return Boolean(env.K_SERVICE) && env.OTEL_SDK_DISABLED !== "true";
}

export async function startOtel({ env = process.env, exporter } = {}) {
  const [
    { NodeTracerProvider },
    { BatchSpanProcessor, ParentBasedSampler, AlwaysOnSampler, TraceIdRatioBasedSampler },
    { resourceFromAttributes },
    core,
    cloudPropagator,
  ] = await Promise.all([
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/core"),
    import("@google-cloud/opentelemetry-cloud-trace-propagator"),
  ]);
  const ratio = Number(env.TRACE_SAMPLE_RATIO ?? "1");
  const unsampledParent = new TraceIdRatioBasedSampler(Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : 1);

  const spanExporter =
    exporter ??
    new (await import("@google-cloud/opentelemetry-cloud-trace-exporter")).TraceExporter({ projectId: env.GOOGLE_CLOUD_PROJECT });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": env.FUNCTION_NAME ?? env.K_SERVICE ?? "function",
      "service.namespace": "pixel-canvas",
      "cloud.provider": "gcp",
      "cloud.platform": "gcp_cloud_run",
    }),
    sampler: new ParentBasedSampler({
      root: new AlwaysOnSampler(),
      remoteParentNotSampled: unsampledParent,
    }),
    spanProcessors: [new BatchSpanProcessor(spanExporter, { scheduledDelayMillis: 1000 })],
  });
  provider.register({
    propagator: new core.CompositePropagator({
      propagators: [new core.W3CTraceContextPropagator(), new cloudPropagator.CloudPropagator()],
    }),
  });
  setFlushHook(() => provider.forceFlush());
  // Cloud Run sends SIGTERM before stopping an instance: export what is left.
  process.once("SIGTERM", () => provider.shutdown().catch(() => {}));
  return provider;
}
