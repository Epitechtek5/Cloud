# Snapshot workflow (#69), event-driven end to end (subject 3.2, C07 §2):
#
#   /snapshot -> command worker -> snapshot.requested -> snapshot-worker
#     reads the grid, renders a timestamped PNG, writes it to the snapshots bucket
#   bucket "object finalized" == snapshot.ready (storage notification below)
#     -> snapshot-notifier: signs a V4 URL, posts it in Discord
#
# The bucket event reaches the notifier through a Cloud Storage Pub/Sub
# notification on the snapshot.ready channel rather than an Eventarc trigger:
# same event (OBJECT_FINALIZE), but the subscription is ours, with the retry
# policy and dead-letter topic of every channel (modules/pubsub). An Eventarc
# trigger would create its own subscription, without DLQ (README, "Adding a
# function"). Each step is a separate function with its own service account.
# The bucket and its lifecycle rules (deletion after 7 days on dev, 90 on prd)
# are in storage.tf.

variable "snapshot_url_ttl_seconds" {
  type        = number
  default     = 3600
  description = "Lifetime of the signed URL posted in Discord, in seconds (V4 URLs: at most 7 days)"

  validation {
    condition     = var.snapshot_url_ttl_seconds >= 60 && var.snapshot_url_ttl_seconds <= 604800
    error_message = "snapshot_url_ttl_seconds must be between 60 and 604800 (7 days)."
  }
}

# Cloud Storage's service agent of the project: it publishes the notifications.
data "google_storage_project_service_account" "this" {
  project = var.project_id
}

# --- snapshot-worker ----------------------------------------------------------

resource "google_service_account" "snapshot_push" {
  project      = var.project_id
  account_id   = "push-snapshot-worker"
  display_name = "Pub/Sub push to snapshot-worker"
  description  = "Signs the push requests of snapshot.requested.sub to the snapshot worker"
}

module "snapshot_worker" {
  source = "./modules/function"

  project_id  = var.project_id
  region      = var.region
  name        = "snapshot-worker"
  description = "Renders the canvas to a timestamped PNG in the snapshots bucket (snapshot.requested)"
  runtime     = var.functions_runtime
  entry_point = "snapshotWorker"

  source_bucket            = google_storage_bucket.functions_source.name
  source_object            = google_storage_bucket_object.functions_source.name
  docker_repository        = google_artifact_registry_repository.functions.id
  build_service_account_id = google_service_account.functions_build.id

  environment_variables = {
    SNAPSHOTS_BUCKET    = google_storage_bucket.snapshots.name
    MAX_SNAPSHOT_PIXELS = "2000000"
  }

  ingress  = "ALLOW_INTERNAL_ONLY"
  invokers = [google_service_account.snapshot_push.member]
  # Reads every painted pixel: within the 300 s ack deadline of snapshot.requested.
  timeout_seconds = 290
  memory          = "1Gi"
  max_instances   = 2

  depends_on = [
    google_project_iam_member.functions_build_logs,
    google_project_iam_member.functions_build_sources,
    google_artifact_registry_repository_iam_member.functions_build,
  ]
}

# Reads the pixels and session/state only.
resource "google_project_iam_member" "snapshot_worker_firestore" {
  project = var.project_id
  role    = "roles/datastore.viewer"
  member  = "serviceAccount:${module.snapshot_worker.service_account_email}"
}

# Adds objects to the snapshots bucket only: no read, no overwrite, no delete.
resource "google_storage_bucket_iam_member" "snapshot_worker" {
  bucket = google_storage_bucket.snapshots.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${module.snapshot_worker.service_account_email}"
}

# --- snapshot.ready: the bucket event -----------------------------------------

resource "google_storage_notification" "snapshot_ready" {
  bucket         = google_storage_bucket.snapshots.name
  payload_format = "JSON_API_V1"
  topic          = module.pubsub.topics["snapshot.ready"]
  event_types    = ["OBJECT_FINALIZE"]
  # Same attribute as the messages of our functions (docs/pubsub.md).
  custom_attributes = {
    event_type = "snapshot.ready"
  }

  # The service agent must be a publisher on the topic first.
  depends_on = [module.pubsub]
}

# --- snapshot-notifier --------------------------------------------------------

resource "google_service_account" "notifier_push" {
  project      = var.project_id
  account_id   = "push-snapshot-notifier"
  display_name = "Pub/Sub push to snapshot-notifier"
  description  = "Signs the push requests of snapshot.ready.sub to the snapshot notifier"
}

module "snapshot_notifier" {
  source = "./modules/function"

  project_id  = var.project_id
  region      = var.region
  name        = "snapshot-notifier"
  description = "Signs a short-lived URL of a new snapshot and posts it in Discord (snapshot.ready)"
  runtime     = var.functions_runtime
  entry_point = "snapshotNotifier"

  source_bucket            = google_storage_bucket.functions_source.name
  source_object            = google_storage_bucket_object.functions_source.name
  docker_repository        = google_artifact_registry_repository.functions.id
  build_service_account_id = google_service_account.functions_build.id

  environment_variables = {
    SIGNED_URL_TTL_SECONDS = tostring(var.snapshot_url_ttl_seconds)
  }

  ingress         = "ALLOW_INTERNAL_ONLY"
  invokers        = [google_service_account.notifier_push.member]
  timeout_seconds = 30
  max_instances   = 2

  depends_on = [
    google_project_iam_member.functions_build_logs,
    google_project_iam_member.functions_build_sources,
    google_artifact_registry_repository_iam_member.functions_build,
  ]
}

# A signed URL carries the signer's permissions: the notifier must be able to
# read the objects it signs, and only those of this bucket.
resource "google_storage_bucket_iam_member" "snapshot_notifier" {
  bucket = google_storage_bucket.snapshots.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${module.snapshot_notifier.service_account_email}"
}

# Signs as itself through IAM signBlob (no key file). Bound on its own service
# account, so it can impersonate that account only (same as auth_discord.tf).
resource "google_service_account_iam_member" "snapshot_notifier_sign_self" {
  service_account_id = "projects/${var.project_id}/serviceAccounts/${module.snapshot_notifier.service_account_email}"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${module.snapshot_notifier.service_account_email}"
}
