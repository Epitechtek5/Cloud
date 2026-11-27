# Tile rasters (#68): the 256x256 PNG of every tile, kept up to date from
# pixel.processed and served from a private bucket.
#
#   draw worker --pixel.processed--> tile-renderer --PNG--> bucket <project>-tiles (private)
#   browser --HTTPS--> load balancer + Cloud CDN --/tiles/*--> tile-reader --reads--> the bucket
#   /get (command worker) reads the same rasters, see command_worker.tf
#
# Question A of docs/frontend-contract.md (how to serve rasters from a private
# bucket) is settled here as option 2: a tile-reader function behind the
# front's load balancer, on the same origin and CDN as the app. README.md,
# section "Tile rasters", gives the reasoning. Code: app/functions/src/tiles.

# --- tile-renderer: pixel.processed -> rasters --------------------------------

# Identity Pub/Sub signs the push requests (OIDC) with; the only invoker of the
# renderer. It has no other role.
resource "google_service_account" "tile_renderer_push" {
  project      = var.project_id
  account_id   = "push-tile-renderer"
  display_name = "Pub/Sub push to tile-renderer"
  description  = "Signs the push requests of pixel.processed.sub to the tile renderer"
}

module "tile_renderer" {
  source = "./modules/function"

  project_id  = var.project_id
  region      = var.region
  name        = "tile-renderer"
  description = "Renders the PNG raster of the tiles touched by pixel.processed (coalesced per tile)"
  runtime     = var.functions_runtime
  entry_point = "tileRenderer"

  source_bucket            = google_storage_bucket.functions_source.name
  source_object            = google_storage_bucket_object.functions_source.name
  docker_repository        = google_artifact_registry_repository.functions.id
  build_service_account_id = google_service_account.functions_build.id

  environment_variables = {
    TILES_BUCKET = google_storage_bucket.tiles.name
    # One render per tile per 1.5 s while a burst lasts; 20 s of work per message.
    RENDER_MIN_INTERVAL_MS = "1500"
    RENDER_BUDGET_MS       = "20000"
  }

  # Pub/Sub push is internal traffic: no gateway, no public URL.
  ingress  = "ALLOW_INTERNAL_ONLY"
  invokers = [google_service_account.tile_renderer_push.member]
  # Within the 30 s ack deadline of pixel.processed; the render budget above is shorter.
  timeout_seconds = 25
  memory          = "512M"
  # A burst on one tile holds one instance for its duration (one leader per tile):
  # spread over hot tiles, bounded for the budget.
  max_instances = 10

  depends_on = [
    google_project_iam_member.functions_build_logs,
    google_project_iam_member.functions_build_sources,
    google_artifact_registry_repository_iam_member.functions_build,
  ]
}

# Reads the pixels and session/state, writes tileState (the coalescing leases).
# Firestore has no per-collection IAM, hence the project-level role (in
# deploy_grantable_roles).
resource "google_project_iam_member" "tile_renderer_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${module.tile_renderer.service_account_email}"
}

# Lists, reads, writes and deletes rasters of the tiles bucket only.
resource "google_storage_bucket_iam_member" "tile_renderer" {
  bucket = google_storage_bucket.tiles.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${module.tile_renderer.service_account_email}"
}

# --- tile-reader: GET /tiles/{tx}/{ty}.png ------------------------------------

# The only reader of the bucket for the browser. Behind the front's load
# balancer, not the API Gateway (open question A, option 2):
# - ingress ALLOW_INTERNAL_AND_GCLB: its run.app URL answers 403 to the internet,
#   only the load balancer reaches it;
# - allUsers as invoker, because a serverless NEG does not sign its requests
#   (IAM cannot tell the load balancer from anyone else), so the ingress is the
#   lock. It serves one thing: a read-only GET of a tile PNG of a canvas that is
#   public to every Discord member anyway, validated against the 391 x 391 grid;
# - the CDN absorbs the traffic (max-age 60), max_instances bounds the cost.
module "tile_reader" {
  source = "./modules/function"

  project_id  = var.project_id
  region      = var.region
  name        = "tile-reader"
  description = "GET /tiles/{tx}/{ty}.png: serves the tile rasters of the private bucket behind the front's CDN"
  runtime     = var.functions_runtime
  entry_point = "tileReader"

  source_bucket            = google_storage_bucket.functions_source.name
  source_object            = google_storage_bucket_object.functions_source.name
  docker_repository        = google_artifact_registry_repository.functions.id
  build_service_account_id = google_service_account.functions_build.id

  environment_variables = {
    TILES_BUCKET = google_storage_bucket.tiles.name
  }

  ingress         = "ALLOW_INTERNAL_AND_GCLB"
  invokers        = ["allUsers"]
  timeout_seconds = 10
  max_instances   = 10

  depends_on = [
    google_project_iam_member.functions_build_logs,
    google_project_iam_member.functions_build_sources,
    google_artifact_registry_repository_iam_member.functions_build,
  ]
}

# Reads session/state only (a raster older than the last /admin clear is never served).
resource "google_project_iam_member" "tile_reader_firestore" {
  project = var.project_id
  role    = "roles/datastore.viewer"
  member  = "serviceAccount:${module.tile_reader.service_account_email}"
}

# Reads rasters of the tiles bucket only.
resource "google_storage_bucket_iam_member" "tile_reader" {
  bucket = google_storage_bucket.tiles.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${module.tile_reader.service_account_email}"
}

# The load balancer reaches the function through a serverless NEG and a backend
# service with Cloud CDN. frontend.tf adds the /tiles/ route to the URL map.
resource "google_compute_region_network_endpoint_group" "tile_reader" {
  project               = var.project_id
  name                  = "tile-reader"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = module.tile_reader.service_name
  }
}

# USE_ORIGIN_HEADERS: the CDN follows the function's Cache-Control (60 s for a
# raster, 30 s for a missing tile), so a regenerated raster shows up within a
# minute and the deltas of the front cover the rest.
resource "google_compute_backend_service" "tile_reader" {
  project               = var.project_id
  name                  = "tile-reader"
  description           = "Tile rasters: serverless NEG of tile-reader behind Cloud CDN"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  enable_cdn            = true

  cdn_policy {
    cache_mode       = "USE_ORIGIN_HEADERS"
    negative_caching = true

    # The path alone identifies a tile: a query string (cache busting) must not bypass the cache.
    cache_key_policy {
      include_host         = true
      include_protocol     = true
      include_query_string = false
    }

    negative_caching_policy {
      code = 404
      ttl  = 30
    }
  }

  backend {
    group = google_compute_region_network_endpoint_group.tile_reader.id
  }

  log_config {
    enable      = true
    sample_rate = 0.1
  }

  depends_on = [google_project_service.this]
}

output "tile_renderer_uri" {
  value       = module.tile_renderer.uri
  description = "Private endpoint of the tile renderer (push target of pixel.processed.sub)"
}
