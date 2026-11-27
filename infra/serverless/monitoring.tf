# Observability of the serverless application (#73): log-based metrics of the
# business events, and the application dashboard (modules/dashboard), deployed
# by the pipeline on dev and prd with the rest of the stack. Reading guide and
# demo: docs/observability.md.

locals {
  app_functions = [
    module.health.service_name,
    module.gateway_stub.service_name,
    module.command_worker.service_name,
    module.draw_worker.service_name,
    module.draw_proxy.service_name,
    module.pixel_reader.service_name,
    module.snapshot_worker.service_name,
    module.snapshot_notifier.service_name,
    "discord-proxy", # optional (discord_proxy_enabled), a name in a filter costs nothing
    "auth-discord",  # optional (discord_client_id)
  ]
  run_logs = "resource.type = \"cloud_run_revision\""
}

# One point per batch applied by the draw worker, by outcome: reason is empty
# when every pixel was accepted, rate_limited or paused otherwise.
resource "google_logging_metric" "draw_batches" {
  project     = var.project_id
  name        = "draw_batches"
  description = "Batches applied by the draw worker, by outcome (empty reason: fully accepted)"
  filter      = "${local.run_logs} AND resource.labels.service_name = \"draw-worker\" AND jsonPayload.message = \"batch applied\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key         = "reason"
      value_type  = "STRING"
      description = "rate_limited, paused or empty"
    }
  }

  label_extractors = {
    reason = "EXTRACT(jsonPayload.reason)"
  }
}

# Who hits the rate limit (or draws while paused).
resource "google_logging_metric" "draw_rejected_batches" {
  project     = var.project_id
  name        = "draw_rejected_batches"
  description = "Batches with rejected pixels, by user"
  filter      = "${local.run_logs} AND resource.labels.service_name = \"draw-worker\" AND jsonPayload.message = \"batch applied\" AND jsonPayload.reason = (\"rate_limited\" OR \"paused\")"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key         = "user_id"
      value_type  = "STRING"
      description = "Discord id of the user"
    }
  }

  label_extractors = {
    user_id = "EXTRACT(jsonPayload.user_id)"
  }
}

resource "google_logging_metric" "admin_refusals" {
  project     = var.project_id
  name        = "admin_refusals"
  description = "Admin commands refused by the command worker (non-admin caller)"
  filter      = "${local.run_logs} AND resource.labels.service_name = \"command-worker\" AND jsonPayload.message = \"admin command refused\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

# Every ERROR line of our functions: a failed message (retried, then
# dead-lettered), an invalid message, an upstream failure.
resource "google_logging_metric" "function_errors" {
  project     = var.project_id
  name        = "function_errors"
  description = "ERROR log lines of the application functions"
  filter      = "${local.run_logs} AND severity >= ERROR AND resource.labels.service_name = (${join(" OR ", [for f in local.app_functions : "\"${f}\""])})"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

module "app_dashboard" {
  source = "./modules/dashboard"

  project_id        = var.project_id
  env               = var.env
  functions         = local.app_functions
  subscriptions     = [for c in keys(module.pubsub.subscriptions) : "${c}.sub"]
  dlq_subscriptions = [for c in keys(module.pubsub.dlq_subscriptions) : "${c}.dlq.sub"]
  buckets           = [google_storage_bucket.tiles.name, google_storage_bucket.snapshots.name]
  log_metrics = {
    draw_batches       = google_logging_metric.draw_batches.name
    rejected_batches   = google_logging_metric.draw_rejected_batches.name
    admin_refusals     = google_logging_metric.admin_refusals.name
    processing_failure = google_logging_metric.function_errors.name
  }
}

output "app_dashboard_url" {
  value       = module.app_dashboard.dashboard_url
  description = "Cloud Monitoring dashboard of the serverless application"
}
