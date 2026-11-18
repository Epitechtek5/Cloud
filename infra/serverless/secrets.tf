# Secret containers are owned by infra/access (persistent.tf): a destroy of
# this stack must not lose the values, which are added out of band, never in
# tfvars or in the state (issue #56). This stack only reads them, and binds
# each function to the secrets listed in its module's secret_env
# (roles/secretmanager.secretAccessor on each of those secrets).
locals {
  secret_ids = toset(["discord-public-key", "discord-bot-token", "discord-oauth-client-secret"])
}

data "google_secret_manager_secret" "this" {
  for_each = local.secret_ids

  project   = var.project_id
  secret_id = each.value
}

# Moved to infra/access: forget them without deleting them (or their values).
removed {
  from = google_secret_manager_secret.this

  lifecycle {
    destroy = false
  }
}

# The deploy pipeline registers the slash commands after the apply (#63,
# deploy-env.yml) with the bot token, read here with its OIDC identity: the
# token is never a GitHub secret. Only this secret, not project-wide access.
resource "google_secret_manager_secret_iam_member" "deploy_reads_bot_token" {
  project   = var.project_id
  secret_id = data.google_secret_manager_secret.this["discord-bot-token"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${coalesce(var.deploy_service_account, "gha-deploy@${var.project_id}.iam.gserviceaccount.com")}"
}
