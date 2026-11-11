# Bot token of the environment's Discord application (issue #63). Used only to
# register the slash commands (app/functions/commands/register.js, run by
# deploy-env.yml). The value is added out of band and never goes through
# Terraform state or GitHub secrets.
resource "google_secret_manager_secret" "bot_token" {
  project   = var.project_id
  secret_id = var.bot_token_secret_id
  labels    = var.labels

  replication {
    auto {}
  }
}

# Only the deploy identity of the environment (OIDC from GitHub) reads it.
resource "google_secret_manager_secret_iam_member" "registrar" {
  for_each = toset(var.registrar_members)

  project   = var.project_id
  secret_id = google_secret_manager_secret.bot_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value
}
