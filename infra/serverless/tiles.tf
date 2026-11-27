# Tile rasters (#68): the 256x256 PNG of every tile, kept up to date from
# pixel.processed and served from a private bucket.
#
#   draw worker --pixel.processed--> tile-renderer --PNG--> bucket <project>-tiles (private)
#   browser --HTTPS--> load balancer + Cloud CDN --/tiles/*--> backend bucket --> the bucket
#   /get (command worker) reads the same rasters, see command_worker.tf
#
# Question A of docs/frontend-contract.md (how to serve rasters from a private
# bucket) is settled here: the front's load balancer reads the bucket through a
# backend bucket, exactly like the app files (frontend.tf). No function is
# reachable from the internet for it. README.md, section "Tile rasters", gives
# the reasoning. Code: app/functions/src/tiles.

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
    # Cache-Control of each raster, followed by the CDN (docs/frontend-contract.md section 2).
    TILE_MAX_AGE_SECONDS = "60"
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

# --- delivery: GET /tiles/{tx}/{ty}.png ---------------------------------------

# The load balancer maps the path to the object name: /tiles/3/4.png reads the
# object tiles/3/4.png (the renderer writes under tiles/). A missing object is a
# 404, which the front reads as an empty tile. The version of a raster is inside
# the PNG (tEXt chunk Tile-Version), so no function has to add a header.
#
# USE_ORIGIN_HEADERS: the CDN follows the Cache-Control the renderer sets on
# each object (TILE_MAX_AGE_SECONDS, 60 s), so a regenerated raster shows up
# within a minute and the real-time deltas of the front cover the rest. A raster
# cached from before an /admin clear is ignored by the front (version <= clearedAt).
resource "google_compute_backend_bucket" "tiles" {
  project     = var.project_id
  name        = "tiles"
  description = "Tile rasters, private bucket behind Cloud CDN"
  bucket_name = google_storage_bucket.tiles.name
  enable_cdn  = true

  cdn_policy {
    cache_mode = "USE_ORIGIN_HEADERS"
  }

  # Same origin as the app (no CORS); the PNG is never sniffed as something else.
  custom_response_headers = [
    "Strict-Transport-Security: max-age=31536000",
    "X-Content-Type-Options: nosniff",
  ]

  depends_on = [google_project_service.this]
}

# Private bucket access: the load balancer reads the bucket as its service agent
# (the one of frontend.tf). objectViewer includes list, so a missing tile is a
# 404 and not a 403.
resource "google_storage_bucket_iam_member" "tiles_lb_reader" {
  bucket = google_storage_bucket.tiles.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:service-${google_storage_bucket.tiles.project_number}@https-lb.iam.gserviceaccount.com"

  depends_on = [google_compute_backend_bucket.tiles]
}

output "tile_renderer_uri" {
  value       = module.tile_renderer.uri
  description = "Private endpoint of the tile renderer (push target of pixel.processed.sub)"
}
