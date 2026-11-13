# One Cloud Run function (2nd gen) with its own identity: a dedicated service
# account that can write logs and traces, read only its own secrets, and be
# invoked only by the members listed in var.invokers.

resource "google_service_account" "this" {
  project      = var.project_id
  account_id   = "fn-${var.name}"
  display_name = "Function ${var.name}"
  description  = var.description
}

resource "google_project_iam_member" "runtime" {
  for_each = toset([
    "roles/logging.logWriter",
    "roles/cloudtrace.agent",
  ])

  project = var.project_id
  role    = each.value
  member  = google_service_account.this.member
}

resource "google_secret_manager_secret_iam_member" "this" {
  for_each = toset(values(var.secret_env))

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.this.member
}

resource "google_cloudfunctions2_function" "this" {
  #checkov:skip=CKV_GCP_124:Ingress is an input defaulting to internal only; ALLOW_ALL is reserved for functions the API Gateway calls over HTTPS, still behind roles/run.invoker
  project     = var.project_id
  location    = var.region
  name        = var.name
  description = var.description

  build_config {
    runtime           = var.runtime
    entry_point       = var.entry_point
    docker_repository = var.docker_repository
    service_account   = var.build_service_account_id

    source {
      storage_source {
        bucket = var.source_bucket
        object = var.source_object
      }
    }
  }

  service_config {
    service_account_email          = google_service_account.this.email
    ingress_settings               = var.ingress
    all_traffic_on_latest_revision = true
    available_memory               = var.memory
    timeout_seconds                = var.timeout_seconds
    min_instance_count             = var.min_instances
    max_instance_count             = var.max_instances
    environment_variables          = merge({ FUNCTION_NAME = var.name }, var.environment_variables)

    dynamic "secret_environment_variables" {
      for_each = var.secret_env
      content {
        key        = secret_environment_variables.key
        project_id = var.project_id
        secret     = secret_environment_variables.value
        version    = "latest"
      }
    }
  }

  # The secrets must be readable before the first revision starts.
  depends_on = [
    google_project_iam_member.runtime,
    google_secret_manager_secret_iam_member.this,
  ]
}

# HTTP callers: the API Gateway for a proxy, the push service account of its
# subscription (infra/serverless/pubsub.tf) for a worker. Keys are the members
# themselves, so var.invokers must be known at plan time.
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  for_each = toset(var.invokers)

  project  = var.project_id
  location = var.region
  name     = google_cloudfunctions2_function.this.service_config[0].service
  role     = "roles/run.invoker"
  member   = each.value
}
