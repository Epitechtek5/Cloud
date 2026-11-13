# Secret containers only. Values are added out of band, never in tfvars or in
# the state, for example:
#   printf '%s' "$VALUE" | gcloud secrets versions add discord-bot-token \
#     --project <project_id> --data-file=-
# A function reads only the secrets listed in its module's secret_env
# (roles/secretmanager.secretAccessor on each of those secrets).
locals {
  secrets = {
    discord-public-key          = "Discord application public key, verifies the Ed25519 signature of interactions"
    discord-bot-token           = "Discord bot token, used by the workers to post follow-ups"
    discord-oauth-client-secret = "Discord OAuth2 client secret of the web login"
    jwt-signing-key             = "Key signing the session JWT issued by POST /auth/discord"
  }
}

resource "google_secret_manager_secret" "this" {
  for_each = local.secrets

  project   = var.project_id
  secret_id = each.key

  annotations = {
    description = each.value
  }

  replication {
    auto {}
  }

  depends_on = [google_project_service.this]
}
