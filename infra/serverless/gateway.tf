# API Gateway (#60): the only public entry point of the application. Every
# function is private (run.invoker for the gateway service account only, never
# allUsers), so a direct call to a function URL gets 403. The spec is
# openapi/api.yaml.tftpl; README.md, section "API Gateway", explains the design.
#
# google_api_gateway_* only exist in the google-beta provider.

variable "gateway_region" {
  type        = string
  default     = "europe-west1"
  description = "Region of the gateway. API Gateway is not available in europe-west9 (prd): europe-west1 is the nearest supported region. The functions stay in `region`"

  validation {
    condition = contains([
      "asia-northeast1", "australia-southeast1", "europe-west1", "europe-west2",
      "us-central1", "us-east1", "us-east4", "us-west2", "us-west3", "us-west4",
    ], var.gateway_region)
    error_message = "API Gateway is only available in asia-northeast1, australia-southeast1, europe-west1, europe-west2, us-central1, us-east1, us-east4, us-west2, us-west3 and us-west4."
  }
}

variable "gateway_tiles_route" {
  type        = bool
  default     = false
  description = "Expose GET /tiles/{tx}/{file} on the gateway. Open question A: option 1 only (tile-reader behind the gateway); option 2 (recommended) serves the tiles from the front's CDN instead. Needs the tile-reader function (#68)"
}

locals {
  gateway_name = "pixel-canvas"

  # Known at plan time without the service account resource: the invokers of
  # the functions are for_each keys, so they cannot depend on a created value.
  # Every function lists google_service_account.gateway in its depends_on.
  gateway_invokers = ["serviceAccount:api-gateway@${var.project_id}.iam.gserviceaccount.com"]

  # Route => function. A route whose function is not delivered (or not
  # deployed in this environment yet) points to the gateway-stub function,
  # which answers 501: the route, its JWT check and its IAM are live and
  # tested. When a function lands, replace its line here.
  gateway_backends = {
    health               = module.health.uri
    discord_interactions = coalesce(one(module.discord_proxy[*].uri), module.gateway_stub.uri)
    auth_discord         = coalesce(one(module.auth_discord[*].uri), module.gateway_stub.uri)
    pixels_draw          = module.gateway_stub.uri # POST /pixels (proxy of #66)
    pixel_get            = module.gateway_stub.uri # GET /pixels/{x}/{y} (proxy of #66)
    tiles                = module.gateway_stub.uri # tile-reader (#68), option 1 of question A
  }

  gateway_openapi = templatefile("${path.module}/openapi/api.yaml.tftpl", {
    env          = var.env
    backends     = local.gateway_backends
    tiles_route  = var.gateway_tiles_route
    jwt_issuer   = local.auth_jwt_issuer
    jwt_audience = local.auth_jwt_audience
    # Public keys Google publishes for the account that signs the session JWT.
    jwt_jwks_uri = "https://www.googleapis.com/robot/v1/metadata/x509/${local.auth_discord_sa}"
  })

  gateway_url = "https://${google_api_gateway_gateway.this.default_hostname}"
}

# Identity of the gateway: it calls the functions as this account. It has no
# project role; its only power is roles/run.invoker on each function.
resource "google_service_account" "gateway" {
  project      = var.project_id
  account_id   = "api-gateway"
  display_name = "API Gateway"
  description  = "Calls the private functions on behalf of the API Gateway"
}

# Placeholder backend of the routes whose function does not exist yet.
module "gateway_stub" {
  source = "./modules/function"

  project_id  = var.project_id
  region      = var.region
  name        = "gateway-stub"
  description = "Answers 501 on the gateway routes whose function is not delivered yet"
  runtime     = var.functions_runtime
  entry_point = "notImplemented"

  source_bucket            = google_storage_bucket.functions_source.name
  source_object            = google_storage_bucket_object.functions_source.name
  docker_repository        = google_artifact_registry_repository.functions.id
  build_service_account_id = google_service_account.functions_build.id

  ingress       = "ALLOW_ALL"
  invokers      = local.gateway_invokers
  max_instances = 1

  depends_on = [
    google_service_account.gateway,
    google_project_iam_member.functions_build_logs,
    google_project_iam_member.functions_build_sources,
    google_artifact_registry_repository_iam_member.functions_build,
  ]
}

resource "google_api_gateway_api" "this" {
  provider = google-beta

  project      = var.project_id
  api_id       = local.gateway_name
  display_name = "Pixel canvas (${var.env})"

  depends_on = [google_project_service.this]
}

# A config is immutable: a changed spec creates a new one (generated id), the
# gateway moves to it, then the old one is deleted. Without create_before_destroy
# the old config could not be deleted while the gateway still uses it.
resource "google_api_gateway_api_config" "this" {
  provider = google-beta

  project              = var.project_id
  api                  = google_api_gateway_api.this.api_id
  api_config_id_prefix = "${local.gateway_name}-"
  display_name         = "Pixel canvas (${var.env})"

  openapi_documents {
    document {
      path     = "openapi.yaml"
      contents = base64encode(local.gateway_openapi)
    }
  }

  gateway_config {
    backend_config {
      google_service_account = google_service_account.gateway.email
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "google_api_gateway_gateway" "this" {
  provider = google-beta

  project      = var.project_id
  region       = var.gateway_region
  gateway_id   = local.gateway_name
  display_name = "Pixel canvas (${var.env})"
  api_config   = google_api_gateway_api_config.this.id
}
