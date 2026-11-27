variable "project_id" {
  type        = string
  description = "GCP project of the dashboard"
}

variable "env" {
  type        = string
  description = "Environment name, shown in the dashboard title"
}

variable "functions" {
  type        = list(string)
  description = "Cloud Run functions (service names) of the application"
}

variable "subscriptions" {
  type        = list(string)
  description = "Consumer subscriptions (<channel>.sub)"
}

variable "dlq_subscriptions" {
  type        = list(string)
  description = "Dead-letter pull subscriptions (<channel>.dlq.sub)"
}

variable "buckets" {
  type        = list(string)
  description = "Application buckets (tiles, snapshots)"
}

variable "log_metrics" {
  type = object({
    draw_batches       = string
    rejected_batches   = string
    admin_refusals     = string
    processing_failure = string
  })
  description = "Names of the log-based metrics of the application (monitoring.tf of the stack)"
}
