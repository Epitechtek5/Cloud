# POST /auth/discord (issue #67): exchanges a Discord OAuth2 code, then issues
# our own short JWT (and optionally a Firebase custom token). Code in
# app/functions/src/auth-discord. Variables and outputs of this function live
# here, next to it, to keep the shared files untouched.
#
# The function is deployed only where a Discord application is configured
# (discord_client_id set in <env>.tfvars). Before the first apply in an
# environment, the Discord client secret needs a version (README.md, Secrets).
#
# The session JWT is signed by the function's own service account through IAM
# Credentials (signJwt): no key of ours, nothing to rotate. The API Gateway
# verifies it with the public keys Google publishes for that account (gateway.tf).

variable "discord_client_id" {
  type        = string
  default     = ""
  description = "Public client id of the Discord application of this environment. Empty: the auth-discord function is not deployed"

  validation {
    condition     = can(regex("^([0-9]{17,20})?$", var.discord_client_id))
    error_message = "discord_client_id must be a Discord snowflake (17 to 20 digits) or empty."
  }
}

variable "auth_discord_redirect_uris" {
  type        = list(string)
  default     = []
  description = "Exact redirect URIs accepted for the web login (front URL of the environment). Must match the Discord Developer Portal. Their origins are also the CORS allow-list"

  validation {
    condition = alltrue([
      for uri in var.auth_discord_redirect_uris :
      can(regex("^(https://[^/#?]+|http://(localhost|127\\.0\\.0\\.1)(:[0-9]+)?)/[^#]*$", uri))
    ])
    error_message = "Redirect URIs must be https (http only on localhost), with a path and no fragment."
  }
}

variable "auth_discord_firebase_custom_token" {
  type        = bool
  default     = false
  description = "Also return a Firebase custom token (uid = Discord id), signed like the session JWT. Needs Firebase Authentication on the project (not managed here yet)"
}

variable "auth_jwt_ttl_seconds" {
  type        = number
  default     = 600
  description = "Lifetime of the session JWT, in seconds"

  validation {
    condition     = var.auth_jwt_ttl_seconds >= 60 && var.auth_jwt_ttl_seconds <= 3600
    error_message = "auth_jwt_ttl_seconds must be between 60 and 3600."
  }
}

variable "auth_discord_http_timeout_ms" {
  type        = number
  default     = 5000
  description = "Timeout of each outgoing call of auth-discord (Discord, metadata server, IAM Credentials), in milliseconds"
}

locals {
  auth_discord_enabled = var.discord_client_id != ""
  auth_discord_name    = "auth-discord"

  # The API Gateway checks these two claims (x-google-issuer and
  # x-google-audiences) and the signature, against the public keys of the
  # function's account (x-google-jwks_uri). The account email is known without
  # the module, which only exists when the function is deployed.
  auth_jwt_issuer   = "urn:huiledecloud:${var.env}:auth-discord"
  auth_jwt_audience = "urn:huiledecloud:${var.env}:api"
  auth_discord_sa   = "fn-${local.auth_discord_name}@${var.project_id}.iam.gserviceaccount.com"
}

module "auth_discord" {
  source = "./modules/function"
  count  = local.auth_discord_enabled ? 1 : 0

  project_id  = var.project_id
  region      = var.region
  name        = local.auth_discord_name
  description = "POST /auth/discord: Discord OAuth2 code exchange, issues the session JWT"
  runtime     = var.functions_runtime
  entry_point = "authDiscord"

  source_bucket            = google_storage_bucket.functions_source.name
  source_object            = google_storage_bucket_object.functions_source.name
  docker_repository        = google_artifact_registry_repository.functions.id
  build_service_account_id = google_service_account.functions_build.id

  environment_variables = {
    DISCORD_CLIENT_ID     = var.discord_client_id
    ALLOWED_REDIRECT_URIS = jsonencode(var.auth_discord_redirect_uris)
    JWT_ISSUER            = local.auth_jwt_issuer
    JWT_AUDIENCE          = local.auth_jwt_audience
    JWT_TTL_SECONDS       = tostring(var.auth_jwt_ttl_seconds)
    FUNCTION_NAME         = local.auth_discord_name
    HTTP_TIMEOUT_MS       = tostring(var.auth_discord_http_timeout_ms)
    FIREBASE_CUSTOM_TOKEN = tostring(var.auth_discord_firebase_custom_token)
  }

  # secretAccessor on this secret only, for this function's account only.
  secret_env = {
    DISCORD_CLIENT_SECRET = google_secret_manager_secret.this["discord-oauth-client-secret"].secret_id
  }

  # The API Gateway calls its backends over the internet (it is not an
  # "internal" source), so ingress is open and run.invoker is the lock: only
  # the gateway service account holds it, never allUsers (gateway.tf).
  ingress  = "ALLOW_ALL"
  invokers = local.gateway_invokers

  # Two Discord calls of at most auth_discord_http_timeout_ms each, plus signing.
  timeout_seconds = 20
  max_instances   = 3

  depends_on = [
    google_service_account.gateway,
    google_project_iam_member.functions_build_logs,
    google_project_iam_member.functions_build_sources,
    google_artifact_registry_repository_iam_member.functions_build,
  ]
}

# The function signs as itself through the IAM Credentials API (signJwt): the
# session JWT, and the Firebase custom token when enabled. The role is bound
# on the function's own service account (the resource), so it can impersonate
# that account only; at project level it could impersonate every account.
resource "google_service_account_iam_member" "auth_discord_sign_self" {
  count = local.auth_discord_enabled ? 1 : 0

  service_account_id = "projects/${var.project_id}/serviceAccounts/${module.auth_discord[0].service_account_email}"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${module.auth_discord[0].service_account_email}"
}

output "auth_discord_uri" {
  value       = one(module.auth_discord[*].uri)
  description = "Private backend of the gateway route POST /auth/discord. Null when the function is not deployed"
}

output "auth_jwt" {
  value = {
    issuer   = local.auth_jwt_issuer
    audience = local.auth_jwt_audience
  }
  description = "Claims of the session JWT, for the gateway's x-google-issuer and x-google-audiences"
}
