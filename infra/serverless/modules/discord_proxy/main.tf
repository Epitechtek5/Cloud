# Discord interactions proxy (issue #62): verifies the Ed25519 signature,
# answers PING, defers commands and publishes them on `discord.command`.
# Code: app/functions/src/discord, entry point `discordProxy`.

# One dedicated service account (least privilege, C05): read its secret,
# publish on discord.command (granted by the Pub/Sub module through
# `publishers`), write logs and traces. Nothing else.
resource "google_service_account" "proxy" {
  project      = var.project_id
  account_id   = var.name
  display_name = "Discord interactions proxy"
}

resource "google_project_iam_member" "proxy" {
  for_each = toset(["roles/logging.logWriter", "roles/cloudtrace.agent"])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.proxy.email}"
}

# The value is the public key of the environment's Discord application, added
# out of band (docs/discord-bot.md): it never goes through Terraform state.
resource "google_secret_manager_secret" "public_key" {
  project   = var.project_id
  secret_id = var.public_key_secret_id
  labels    = var.labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "proxy" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.public_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.proxy.email}"
}

resource "google_cloudfunctions2_function" "proxy" {
  #checkov:skip=CKV_GCP_124:API Gateway reaches the backend from outside the VPC, so ingress must be ALLOW_ALL; access is enforced by IAM (run.invoker for the gateway only, no allUsers)
  project  = var.project_id
  location = var.region
  name     = var.name
  labels   = var.labels

  build_config {
    runtime         = "nodejs22"
    entry_point     = "discordProxy"
    service_account = var.build_service_account

    source {
      storage_source {
        bucket = var.source_bucket
        object = var.source_object
      }
    }
  }

  service_config {
    service_account_email = google_service_account.proxy.email
    # Discord gives 3 s to answer: the proxy only verifies and publishes.
    timeout_seconds    = 10
    available_memory   = "256M"
    min_instance_count = 0
    max_instance_count = var.max_instances
    # Reachable by the API Gateway, but every call needs an identity token of a
    # member of invoker_members (no allUsers binding).
    ingress_settings               = "ALLOW_ALL"
    all_traffic_on_latest_revision = true

    environment_variables = {
      GOOGLE_CLOUD_PROJECT      = var.project_id
      DISCORD_PUBLIC_KEY_SECRET = google_secret_manager_secret.public_key.secret_id
      LOG_LEVEL                 = "INFO"
    }
  }

  depends_on = [google_secret_manager_secret_iam_member.proxy]
}

# Invocation goes through the Cloud Run service behind the function.
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  for_each = toset(var.invoker_members)

  project  = var.project_id
  location = var.region
  name     = google_cloudfunctions2_function.proxy.service_config[0].service
  role     = "roles/run.invoker"
  member   = each.value
}
