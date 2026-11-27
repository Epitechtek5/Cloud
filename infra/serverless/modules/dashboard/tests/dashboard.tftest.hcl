# Plan-level checks of the application dashboard, with a mocked provider.
# Run: terraform -chdir=infra/serverless/modules/dashboard init -backend=false && terraform -chdir=... test
mock_provider "google" {}

variables {
  project_id        = "demo-project"
  env               = "dev"
  functions         = ["draw-proxy", "draw-worker"]
  subscriptions     = ["pixel.draw.sub", "discord.command.sub"]
  dlq_subscriptions = ["pixel.draw.dlq.sub", "discord.command.dlq.sub"]
  buckets           = ["demo-project-snapshots"]
  log_metrics = {
    draw_batches       = "draw_batches"
    rejected_batches   = "draw_rejected_batches"
    admin_refusals     = "admin_refusals"
    processing_failure = "worker_failures"
  }
}

run "covers_functions_queues_dlq_gateway_and_storage" {
  command = plan

  assert {
    condition = alltrue([for prefix in ["Functions", "Queues", "DLQ", "API Gateway", "Firestore", "Buckets", "Draw worker"] :
    anytrue([for t in output.charts : startswith(t, prefix)])])
    error_message = "Every part of the serverless app needs its row."
  }

  assert {
    condition     = strcontains(google_monitoring_dashboard.this.dashboard_json, "resource.labels.subscription_id = one_of(\\\"pixel.draw.dlq.sub\\\", \\\"discord.command.dlq.sub\\\")")
    error_message = "The DLQ widget must watch every dead-letter subscription."
  }

  assert {
    condition = alltrue([for m in ["run.googleapis.com/request_count", "run.googleapis.com/request_latencies", "run.googleapis.com/container/instance_count",
      "pubsub.googleapis.com/subscription/num_undelivered_messages", "pubsub.googleapis.com/subscription/oldest_unacked_message_age",
      "pubsub.googleapis.com/subscription/dead_letter_message_count", "apigateway.googleapis.com/proxy/request_count",
      "firestore.googleapis.com/document/write_ops_count", "storage.googleapis.com/api/request_count",
    "logging.googleapis.com/user/draw_batches"] : strcontains(google_monitoring_dashboard.this.dashboard_json, m)])
    error_message = "A metric required by the issue (#73) is missing."
  }

  assert {
    condition     = strcontains(google_monitoring_dashboard.this.dashboard_json, "REDUCE_PERCENTILE_99")
    error_message = "Latency must show p99."
  }

  assert {
    condition     = jsondecode(google_monitoring_dashboard.this.dashboard_json).displayName == "Pixel canvas · serverless application (dev)"
    error_message = "The title names the environment."
  }
}

run "tiles_do_not_overlap" {
  command = plan

  assert {
    condition     = length(distinct([for t in jsondecode(google_monitoring_dashboard.this.dashboard_json).mosaicLayout.tiles : "${t.xPos},${t.yPos}"])) == length(jsondecode(google_monitoring_dashboard.this.dashboard_json).mosaicLayout.tiles)
    error_message = "Two tiles share a position."
  }
}
