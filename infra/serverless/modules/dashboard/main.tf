# Serverless application dashboard (#73): functions, queues and DLQs, API
# Gateway, Firestore and buckets on one page (subject 04, C08 §2, §5, §9).
# "Queues are the heart of the system; a growing backlog or a filling DLQ is
# the earliest signal of trouble" (C08 §5): the queue rows come right after the
# functions. Reading guide in docs/observability.md.

locals {
  one_of = {
    functions     = join(", ", [for f in var.functions : "\"${f}\""])
    subscriptions = join(", ", [for s in var.subscriptions : "\"${s}\""])
    dlqs          = join(", ", [for s in var.dlq_subscriptions : "\"${s}\""])
    buckets       = join(", ", [for b in var.buckets : "\"${b}\""])
  }

  run       = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = one_of(${local.one_of.functions})"
  sub       = "resource.type = \"pubsub_subscription\" AND resource.labels.subscription_id = one_of(${local.one_of.subscriptions})"
  dlq       = "resource.type = \"pubsub_subscription\" AND resource.labels.subscription_id = one_of(${local.one_of.dlqs})"
  gateway   = "resource.type = \"apigateway.googleapis.com/Gateway\""
  bucket    = "resource.type = \"gcs_bucket\" AND resource.labels.bucket_name = one_of(${local.one_of.buckets})"
  logmetric = "resource.type = \"cloud_run_revision\""

  # One chart = one or more series: { filter, aligner, reducer, group_by, legend }.
  charts = [
    # --- Functions (Cloud Run) -------------------------------------------------
    {
      title = "Functions · requests per second", y = "req/s", series = [
        { filter = "metric.type = \"run.googleapis.com/request_count\" AND ${local.run}", aligner = "ALIGN_RATE", reducer = "REDUCE_SUM", group_by = ["resource.label.service_name"], legend = "$${resource.labels.service_name}" },
      ]
    },
    {
      title = "Functions · 5xx errors per second", y = "err/s", series = [
        { filter = "metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\" AND ${local.run}", aligner = "ALIGN_RATE", reducer = "REDUCE_SUM", group_by = ["resource.label.service_name"], legend = "$${resource.labels.service_name}" },
      ]
    },
    {
      title = "Functions · latency p50 / p95 / p99", y = "ms", series = [
        for p in ["50", "95", "99"] : { filter = "metric.type = \"run.googleapis.com/request_latencies\" AND ${local.run}", aligner = "ALIGN_DELTA", reducer = "REDUCE_PERCENTILE_${p}", group_by = ["resource.label.service_name"], legend = "p${p} $${resource.labels.service_name}" }
      ]
    },
    {
      title = "Functions · instances", y = "instances", series = [
        { filter = "metric.type = \"run.googleapis.com/container/instance_count\" AND ${local.run}", aligner = "ALIGN_MAX", reducer = "REDUCE_SUM", group_by = ["resource.label.service_name"], legend = "$${resource.labels.service_name}" },
      ]
    },
    {
      title = "Functions · max concurrent requests per instance", y = "requests", series = [
        { filter = "metric.type = \"run.googleapis.com/container/max_request_concurrencies\" AND ${local.run}", aligner = "ALIGN_DELTA", reducer = "REDUCE_PERCENTILE_99", group_by = ["resource.label.service_name"], legend = "$${resource.labels.service_name}" },
      ]
    },
    {
      # Cloud Run answers 429 when max_instances is reached: the cost ceiling is hit.
      title = "Functions · throttled (429, max instances reached)", y = "req/s", series = [
        { filter = "metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code = \"429\" AND ${local.run}", aligner = "ALIGN_RATE", reducer = "REDUCE_SUM", group_by = ["resource.label.service_name"], legend = "$${resource.labels.service_name}" },
      ]
    },
    # --- Queues ------------------------------------------------------------------
    {
      title = "Queues · backlog (undelivered messages)", y = "messages", series = [
        { filter = "metric.type = \"pubsub.googleapis.com/subscription/num_undelivered_messages\" AND ${local.sub}", aligner = "ALIGN_MAX", reducer = "REDUCE_SUM", group_by = ["resource.label.subscription_id"], legend = "$${resource.labels.subscription_id}" },
      ]
    },
    {
      title = "Queues · oldest unacked message age", y = "s", series = [
        { filter = "metric.type = \"pubsub.googleapis.com/subscription/oldest_unacked_message_age\" AND ${local.sub}", aligner = "ALIGN_MAX", reducer = "REDUCE_MAX", group_by = ["resource.label.subscription_id"], legend = "$${resource.labels.subscription_id}" },
      ]
    },
    {
      title = "Queues · push ack latency p95", y = "ms", series = [
        { filter = "metric.type = \"pubsub.googleapis.com/subscription/push_request_latencies\" AND ${local.sub}", aligner = "ALIGN_DELTA", reducer = "REDUCE_PERCENTILE_95", group_by = ["resource.label.subscription_id"], legend = "$${resource.labels.subscription_id}" },
      ]
    },
    {
      title = "Queues · push responses by class", y = "req/s", series = [
        { filter = "metric.type = \"pubsub.googleapis.com/subscription/push_request_count\" AND ${local.sub}", aligner = "ALIGN_RATE", reducer = "REDUCE_SUM", group_by = ["resource.label.subscription_id", "metric.label.response_class"], legend = "$${resource.labels.subscription_id} $${metric.labels.response_class}" },
      ]
    },
    {
      # A filling DLQ: messages that failed max_delivery_attempts times.
      title = "DLQ · messages waiting in the dead-letter queues", y = "messages", series = [
        { filter = "metric.type = \"pubsub.googleapis.com/subscription/num_undelivered_messages\" AND ${local.dlq}", aligner = "ALIGN_MAX", reducer = "REDUCE_SUM", group_by = ["resource.label.subscription_id"], legend = "$${resource.labels.subscription_id}" },
      ]
    },
    {
      title = "DLQ · messages dead-lettered", y = "msg/min", series = [
        { filter = "metric.type = \"pubsub.googleapis.com/subscription/dead_letter_message_count\" AND ${local.sub}", aligner = "ALIGN_DELTA", reducer = "REDUCE_SUM", group_by = ["resource.label.subscription_id"], legend = "$${resource.labels.subscription_id}" },
      ]
    },
    # --- API Gateway ---------------------------------------------------------------
    {
      title = "API Gateway · requests by response class", y = "req/s", series = [
        { filter = "metric.type = \"apigateway.googleapis.com/proxy/request_count\" AND ${local.gateway}", aligner = "ALIGN_RATE", reducer = "REDUCE_SUM", group_by = ["metric.label.response_code_class"], legend = "$${metric.labels.response_code_class}" },
      ]
    },
    {
      title = "API Gateway · latency p50 / p95 / p99", y = "ms", series = [
        for p in ["50", "95", "99"] : { filter = "metric.type = \"apigateway.googleapis.com/proxy/request_latencies\" AND ${local.gateway}", aligner = "ALIGN_DELTA", reducer = "REDUCE_PERCENTILE_${p}", group_by = [], legend = "p${p}" }
      ]
    },
    # --- Storage -------------------------------------------------------------------
    {
      title = "Firestore · reads, writes, deletes per second", y = "ops/s", series = [
        for op in ["read", "write", "delete"] : { filter = "metric.type = \"firestore.googleapis.com/document/${op}_ops_count\"", aligner = "ALIGN_RATE", reducer = "REDUCE_SUM", group_by = [], legend = op }
      ]
    },
    {
      title = "Firestore · API errors by code", y = "req/s", series = [
        { filter = "metric.type = \"firestore.googleapis.com/api/request_count\" AND metric.labels.response_code != \"OK\"", aligner = "ALIGN_RATE", reducer = "REDUCE_SUM", group_by = ["metric.label.response_code"], legend = "$${metric.labels.response_code}" },
      ]
    },
    {
      title = "Buckets · operations by method", y = "req/s", series = [
        { filter = "metric.type = \"storage.googleapis.com/api/request_count\" AND ${local.bucket}", aligner = "ALIGN_RATE", reducer = "REDUCE_SUM", group_by = ["resource.label.bucket_name", "metric.label.method"], legend = "$${resource.labels.bucket_name} $${metric.labels.method}" },
      ]
    },
    # --- Application (log-based metrics) -----------------------------------------
    {
      title = "Draw worker · batches by outcome", y = "batches/min", series = [
        { filter = "metric.type = \"logging.googleapis.com/user/${var.log_metrics.draw_batches}\" AND ${local.logmetric}", aligner = "ALIGN_DELTA", reducer = "REDUCE_SUM", group_by = ["metric.label.reason"], legend = "$${metric.labels.reason}" },
      ]
    },
    {
      title = "Draw worker · rate-limited or paused batches by user", y = "batches/min", series = [
        { filter = "metric.type = \"logging.googleapis.com/user/${var.log_metrics.rejected_batches}\" AND ${local.logmetric}", aligner = "ALIGN_DELTA", reducer = "REDUCE_SUM", group_by = ["metric.label.user_id"], legend = "$${metric.labels.user_id}" },
      ]
    },
    {
      title = "Workers · failures (retried) and refused admin commands", y = "per min", series = [
        { filter = "metric.type = \"logging.googleapis.com/user/${var.log_metrics.processing_failure}\" AND ${local.logmetric}", aligner = "ALIGN_DELTA", reducer = "REDUCE_SUM", group_by = ["resource.label.service_name"], legend = "failure $${resource.labels.service_name}" },
        { filter = "metric.type = \"logging.googleapis.com/user/${var.log_metrics.admin_refusals}\" AND ${local.logmetric}", aligner = "ALIGN_DELTA", reducer = "REDUCE_SUM", group_by = [], legend = "admin refused" },
      ]
    },
  ]

  chart_widgets = [
    for c in local.charts : {
      title = c.title
      xyChart = {
        chartOptions = { mode = "COLOR" }
        yAxis        = { label = c.y, scale = "LINEAR" }
        dataSets = [
          for s in c.series : {
            plotType       = "LINE"
            targetAxis     = "Y1"
            legendTemplate = s.legend
            timeSeriesQuery = {
              timeSeriesFilter = {
                filter = s.filter
                aggregation = {
                  alignmentPeriod    = "60s"
                  perSeriesAligner   = s.aligner
                  crossSeriesReducer = s.reducer
                  groupByFields      = s.group_by
                }
              }
            }
          }
        ]
      }
    }
  ]

  intro = {
    title = "How to read this dashboard"
    text = {
      format  = "MARKDOWN"
      content = "Pixel canvas, **${var.env}**. Path of a draw: API Gateway → `draw-proxy` → `pixel.draw` → `draw-worker` → Firestore → `pixel.processed`. A brush burst shows as a spike of requests and instances, a backlog that rises then drains, and Firestore writes. A failing worker shows in *failures*, then in the **DLQ** rows after 5 attempts. Logs and traces: `docs/observability.md`."
    }
  }

  # 12-column mosaic: the intro on one row, then two charts per row.
  tiles = concat(
    [{ xPos = 0, yPos = 0, width = 12, height = 2, widget = local.intro }],
    [for i, w in local.chart_widgets : { xPos = (i % 2) * 6, yPos = 2 + floor(i / 2) * 4, width = 6, height = 4, widget = w }],
  )
}

resource "google_monitoring_dashboard" "this" {
  project = var.project_id
  dashboard_json = jsonencode({
    displayName  = "Pixel canvas · serverless application (${var.env})"
    mosaicLayout = { columns = 12, tiles = local.tiles }
    labels       = { serverless = "" }
  })
}
