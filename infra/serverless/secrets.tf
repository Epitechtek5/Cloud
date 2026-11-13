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

# The deploy pipeline registers the slash commands after the apply (#63,
# deploy-env.yml) with the bot token, read here with its OIDC identity: the
# token is never a GitHub secret. Only this secret, not project-wide access.
resource "google_secret_manager_secret_iam_member" "deploy_reads_bot_token" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.this["discord-bot-token"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${coalesce(var.deploy_service_account, "gha-deploy@${var.project_id}.iam.gserviceaccount.com")}"
}
