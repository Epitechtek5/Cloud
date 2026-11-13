# Frontend hosting (#70): the Vite build (dist/) in a private bucket, served
# over HTTPS by a global external Application Load Balancer with Cloud CDN.
# The bucket is never public: only the load balancer service agent can read it
# ("private bucket access"). README.md, section "Frontend hosting", explains the
# choice and the domain question.

locals {
  # The pipeline artifact holds the build under frontend/ (deploy.yml), and the
  # same artifact is promoted from dev to prd. A local plan falls back to
  # app/frontend/dist once `npm run build` has run. PR plans and destroy have
  # neither: nothing is uploaded (see the frontend_artifact check).
  frontend_artifact_dir = "${var.app_artifact_dir}/frontend"
  frontend_local_dir    = "${path.module}/../../app/frontend/dist"
  frontend_dir = (
    var.app_artifact_dir != "" && fileexists("${local.frontend_artifact_dir}/index.html") ? local.frontend_artifact_dir :
    fileexists("${local.frontend_local_dir}/index.html") ? local.frontend_local_dir : ""
  )
  # config.json is generated below, never taken from the build.
  frontend_files = local.frontend_dir == "" ? toset([]) : setsubtract(fileset(local.frontend_dir, "**"), ["config.json"])

  # Cloud Storage would serve application/octet-stream without an explicit type.
  frontend_content_types = {
    html        = "text/html; charset=utf-8"
    js          = "text/javascript; charset=utf-8"
    css         = "text/css; charset=utf-8"
    json        = "application/json"
    map         = "application/json"
    svg         = "image/svg+xml"
    png         = "image/png"
    webp        = "image/webp"
    ico         = "image/x-icon"
    woff2       = "font/woff2"
    txt         = "text/plain; charset=utf-8"
    webmanifest = "application/manifest+json"
  }

  # Vite puts every hashed file under assets/: a new build gives new names, so
  # they can be cached for a year. Everything else (index.html, config.json)
  # must be revalidated, or a deploy would not reach the browsers.
  frontend_cache_immutable  = "public, max-age=31536000, immutable"
  frontend_cache_revalidate = "no-cache"

  # Without a domain of our own, sslip.io resolves <a-b-c-d>.sslip.io to the IP
  # a.b.c.d, which is enough for a Google-managed certificate. See README.md.
  frontend_domain = coalesce(var.frontend_domain, "${replace(google_compute_global_address.frontend.address, ".", "-")}.sslip.io")

  # #60: replace with the gateway URL (https://<gateway default_hostname>) once
  # the API Gateway exists. Until then the variable (empty by default) is used.
  frontend_api_base = var.api_base_url

  # Read by the front at startup (app/frontend/src/runtimeConfig.ts). Only
  # public values: this ends up in the state and on the CDN.
  frontend_runtime_config = {
    env             = var.env
    apiBase         = local.frontend_api_base
    discordClientId = var.discord_client_id
    firebase = {
      apiKey     = var.firebase_api_key
      projectId  = var.project_id
      authDomain = "${var.project_id}.firebaseapp.com"
    }
  }

  # #68 (open question A, option 2): set this to the backend service of the
  # tile-reader (serverless NEG, function ingress internal-and-cloud-load-balancing)
  # to serve /tiles/* from the same origin and CDN. Null: no route.
  frontend_tiles_backend = null
}

# Warnings, not errors: PR plans and destroy are expected to take these paths.
check "frontend_artifact" {
  assert {
    condition     = local.frontend_dir == local.frontend_artifact_dir
    error_message = "No frontend/index.html in app_artifact_dir: the front is not uploaded from the pipeline artifact (a PR plan shows its objects removed). Expected on PR plans, local plans and destroy only."
  }
}

check "frontend_runtime_config" {
  assert {
    condition     = local.frontend_api_base != "" && var.discord_client_id != "" && var.firebase_api_key != ""
    error_message = "config.json is incomplete (apiBase, discordClientId or firebase.apiKey empty): the page loads but shows a configuration error until they are set."
  }
}

resource "google_storage_bucket" "frontend" {
  #checkov:skip=CKV_GCP_62:Access logs would need a second bucket; the load balancer already logs every request
  name     = "${var.project_id}-frontend"
  project  = var.project_id
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  # Holds only the build, uploaded again by the next apply.
  force_destroy = true

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 7
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.this]
}

resource "google_storage_bucket_object" "frontend" {
  for_each = local.frontend_files

  name          = each.value
  bucket        = google_storage_bucket.frontend.name
  source        = "${local.frontend_dir}/${each.value}"
  content_type  = lookup(local.frontend_content_types, lower(try(regex("\\.([^./]+)$", each.value)[0], "")), "application/octet-stream")
  cache_control = startswith(each.value, "assets/") ? local.frontend_cache_immutable : local.frontend_cache_revalidate
}

# Per environment, next to the same build: this file is what makes one
# artifact work on dev and prd.
resource "google_storage_bucket_object" "frontend_config" {
  name          = "config.json"
  bucket        = google_storage_bucket.frontend.name
  content       = jsonencode(local.frontend_runtime_config)
  content_type  = "application/json"
  cache_control = local.frontend_cache_revalidate
}

# USE_ORIGIN_HEADERS: the CDN follows the Cache-Control set on each object
# above (a year for assets/, not cached for index.html and config.json), so a
# deploy needs no cache invalidation.
resource "google_compute_backend_bucket" "frontend" {
  project          = var.project_id
  name             = "frontend"
  description      = "Frontend build, private bucket behind Cloud CDN"
  bucket_name      = google_storage_bucket.frontend.name
  enable_cdn       = true
  compression_mode = "AUTOMATIC"

  cdn_policy {
    cache_mode = "USE_ORIGIN_HEADERS"
  }

  # No X-Frame-Options or frame-ancestors: the Discord Activity shows the page
  # in an iframe.
  custom_response_headers = [
    "Strict-Transport-Security: max-age=31536000",
    "X-Content-Type-Options: nosniff",
    "Referrer-Policy: strict-origin-when-cross-origin",
  ]

  depends_on = [google_project_service.this]
}

# Private bucket access: the load balancer reads the bucket as its service
# agent, which Google creates with the first backend bucket of the project.
# The project number comes from the bucket: a google_project data source would
# need the Cloud Resource Manager API at plan time.
resource "google_storage_bucket_iam_member" "frontend_lb_reader" {
  bucket = google_storage_bucket.frontend.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:service-${google_storage_bucket.frontend.project_number}@https-lb.iam.gserviceaccount.com"

  depends_on = [google_compute_backend_bucket.frontend]
}

resource "google_compute_global_address" "frontend" {
  project = var.project_id
  name    = "frontend"

  depends_on = [google_project_service.this]
}

# The name carries a hash of the domain: a new domain needs a new certificate,
# created before the old one is detached from the proxy.
resource "google_compute_managed_ssl_certificate" "frontend" {
  project = var.project_id
  name    = "frontend-${substr(sha1(local.frontend_domain), 0, 8)}"

  managed {
    domains = [local.frontend_domain]
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [google_project_service.this]
}

resource "google_compute_ssl_policy" "frontend" {
  project         = var.project_id
  name            = "frontend-tls12"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"

  depends_on = [google_project_service.this]
}

resource "google_compute_url_map" "frontend" {
  project         = var.project_id
  name            = "frontend"
  default_service = google_compute_backend_bucket.frontend.id

  host_rule {
    hosts        = ["*"]
    path_matcher = "app"
  }

  path_matcher {
    name            = "app"
    default_service = google_compute_backend_bucket.frontend.id

    # A bucket has no index page: "/" (also the OAuth redirect URI and the
    # Activity entry point) is rewritten to index.html. The query is kept.
    route_rules {
      priority = 1
      service  = google_compute_backend_bucket.frontend.id
      match_rules {
        full_path_match = "/"
      }
      route_action {
        url_rewrite {
          path_prefix_rewrite = "/index.html"
        }
      }
    }

    dynamic "route_rules" {
      for_each = local.frontend_tiles_backend == null ? [] : [local.frontend_tiles_backend]
      content {
        priority = 2
        service  = route_rules.value
        match_rules {
          prefix_match = "/tiles/"
        }
      }
    }
  }
}

resource "google_compute_target_https_proxy" "frontend" {
  project          = var.project_id
  name             = "frontend-https"
  url_map          = google_compute_url_map.frontend.id
  ssl_certificates = [google_compute_managed_ssl_certificate.frontend.id]
  ssl_policy       = google_compute_ssl_policy.frontend.id
}

resource "google_compute_global_forwarding_rule" "frontend_https" {
  project               = var.project_id
  name                  = "frontend-https"
  target                = google_compute_target_https_proxy.frontend.id
  ip_address            = google_compute_global_address.frontend.id
  port_range            = "443"
  ip_protocol           = "TCP"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

# Port 80 only answers with a redirect to HTTPS (query kept).
resource "google_compute_url_map" "frontend_redirect" {
  project = var.project_id
  name    = "frontend-http-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }

  depends_on = [google_project_service.this]
}

resource "google_compute_target_http_proxy" "frontend_redirect" {
  project = var.project_id
  name    = "frontend-http-redirect"
  url_map = google_compute_url_map.frontend_redirect.id
}

resource "google_compute_global_forwarding_rule" "frontend_http" {
  project               = var.project_id
  name                  = "frontend-http"
  target                = google_compute_target_http_proxy.frontend_redirect.id
  ip_address            = google_compute_global_address.frontend.id
  port_range            = "80"
  ip_protocol           = "TCP"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}
