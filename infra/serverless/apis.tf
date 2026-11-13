locals {
  services = toset([
    "run.googleapis.com",
    "cloudfunctions.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "apigateway.googleapis.com",
    "servicemanagement.googleapis.com",
    "servicecontrol.googleapis.com",
    "pubsub.googleapis.com",
    "eventarc.googleapis.com",
    "firestore.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudtrace.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
    "storage.googleapis.com",
  ])
}

# disable_on_destroy = false: destroying this stack must not switch off APIs
# that the foundation (logging, monitoring, storage) also relies on.
resource "google_project_service" "this" {
  for_each = local.services

  project                    = var.project_id
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
}
