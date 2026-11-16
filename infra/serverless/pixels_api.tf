# Web API of the canvas (#66), behind the API Gateway (session JWT checked
# there, user forwarded in X-Apigateway-Api-Userinfo). Two functions, one job
# and one identity each (SRP):
# - draw-proxy, POST /pixels: validates and publishes pixel.draw (publisher on
#   that topic only, pubsub.tf). No Firestore role: it cannot write the grid.
# - pixel-reader, GET /pixels/{x}/{y}: reads one pixel (roles/datastore.viewer).
# Code in app/functions/src/pixels, contract in docs/frontend-contract.md §1.

locals {
  # The browser calls the gateway from the front's origin: same allow-list as
  # the login (auth_discord.tf).
  pixels_api_origins = distinct([for uri in var.auth_discord_redirect_uris : regex("^[a-z]+://[^/]+", uri)])
}

module "draw_proxy" {
  source = "./modules/function"

  project_id  = var.project_id
  region      = var.region
  name        = "draw-proxy"
  description = "POST /pixels: validates a brush batch and publishes pixel.draw"
  runtime     = var.functions_runtime
  entry_point = "drawProxy"

  source_bucket            = google_storage_bucket.functions_source.name
  source_object            = google_storage_bucket_object.functions_source.name
  docker_repository        = google_artifact_registry_repository.functions.id
  build_service_account_id = google_service_account.functions_build.id

  environment_variables = {
    ALLOWED_ORIGINS = jsonencode(local.pixels_api_origins)
  }

  # Called by the API Gateway, still behind roles/run.invoker (gateway.tf).
  ingress         = "ALLOW_ALL"
  invokers        = local.gateway_invokers
  timeout_seconds = 10
  max_instances   = 10

  depends_on = [
    google_service_account.gateway,
    google_project_iam_member.functions_build_logs,
    google_project_iam_member.functions_build_sources,
    google_artifact_registry_repository_iam_member.functions_build,
  ]
}

module "pixel_reader" {
  source = "./modules/function"

  project_id  = var.project_id
  region      = var.region
  name        = "pixel-reader"
  description = "GET /pixels/{x}/{y}: colour, author and time of one pixel"
  runtime     = var.functions_runtime
  entry_point = "pixelReader"

  source_bucket            = google_storage_bucket.functions_source.name
  source_object            = google_storage_bucket_object.functions_source.name
  docker_repository        = google_artifact_registry_repository.functions.id
  build_service_account_id = google_service_account.functions_build.id

  environment_variables = {
    ALLOWED_ORIGINS = jsonencode(local.pixels_api_origins)
  }

  ingress         = "ALLOW_ALL"
  invokers        = local.gateway_invokers
  timeout_seconds = 10
  max_instances   = 5

  depends_on = [
    google_service_account.gateway,
    google_project_iam_member.functions_build_logs,
    google_project_iam_member.functions_build_sources,
    google_artifact_registry_repository_iam_member.functions_build,
  ]
}

# Read-only: the inspection never changes anything.
resource "google_project_iam_member" "pixel_reader_firestore" {
  project = var.project_id
  role    = "roles/datastore.viewer"
  member  = "serviceAccount:${module.pixel_reader.service_account_email}"
}
