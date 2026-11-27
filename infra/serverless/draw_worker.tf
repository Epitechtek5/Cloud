# Draw worker (#65): the only writer of the grid. Consumes pixel.draw (push
# subscription with retry and DLQ, pubsub.tf) from the web proxy and /draw,
# applies the pause and the per-user rate limit in a Firestore transaction,
# then publishes pixel.processed. Code in app/functions/src/draw, rules in
# docs/data-model.md §6.

variable "draw_default_rate_limit" {
  type        = number
  default     = 20
  description = "Pixels per window a user may draw without an /admin ratelimit override (subject 3.3: 20 per minute)"

  validation {
    condition     = var.draw_default_rate_limit >= 0 && floor(var.draw_default_rate_limit) == var.draw_default_rate_limit
    error_message = "draw_default_rate_limit must be a non-negative integer."
  }
}

resource "google_service_account" "draw_push" {
  project      = var.project_id
  account_id   = "push-draw-worker"
  display_name = "Pub/Sub push to draw-worker"
  description  = "Signs the push requests of pixel.draw.sub to the draw worker"
}

module "draw_worker" {
  source = "./modules/function"

  project_id  = var.project_id
  region      = var.region
  name        = "draw-worker"
  description = "Applies pixel.draw batches (pause, rate limit, idempotent pixel writes)"
  runtime     = var.functions_runtime
  entry_point = "drawWorker"

  source_bucket            = google_storage_bucket.functions_source.name
  source_object            = google_storage_bucket_object.functions_source.name
  docker_repository        = google_artifact_registry_repository.functions.id
  build_service_account_id = google_service_account.functions_build.id

  environment_variables = {
    DEFAULT_RATE_LIMIT  = tostring(var.draw_default_rate_limit)
    RATE_WINDOW_SECONDS = "60"
  }

  ingress  = "ALLOW_INTERNAL_ONLY"
  invokers = [google_service_account.draw_push.member]
  # Within the 30 s ack deadline of pixel.draw.
  timeout_seconds = 25
  # A brush burst scales out here; Firestore transactions keep each user's
  # quota consistent across instances and across concurrent requests.
  # Each batch mostly waits on Firestore, so one instance handles several at
  # once (Cloud Run needs a full vCPU for concurrency > 1). 20 x 10 = 200
  # batches in flight: past that Cloud Run answers 429, which Pub/Sub counts as
  # a failed delivery attempt and, after 5, dead-letters a valid batch.
  max_instances = 20
  cpu           = "1"
  memory        = "512M"
  concurrency   = 10

  depends_on = [
    time_sleep.functions_build_iam,
  ]
}

# pixels, users, userEvents, processedBatches (no per-collection IAM in Firestore).
resource "google_project_iam_member" "draw_worker_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${module.draw_worker.service_account_email}"
}

output "draw_worker_uri" {
  value       = module.draw_worker.uri
  description = "Private endpoint of the draw worker (push target of pixel.draw.sub)"
}
