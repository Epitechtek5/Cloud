# What must survive a destroy of the workload (subject 2.2, issue #56).
# destroy.yml never touches this stack, so these keep their value across a
# destroy -> apply cycle, and the next apply converges with no manual step:
#
# - the frontend IP: the dev URL (<a-b-c-d>.sslip.io), the Discord OAuth2
#   redirect URIs (dev.tfvars and the Discord Developer Portal) and the managed
#   certificate are all derived from it. A new IP would mean editing all three
#   by hand. An unattached global IP is billed (a few dollars a month): the one
#   billable leftover after a destroy, accepted for that reason;
# - the Secret Manager containers: their values are added by hand, never in
#   tfvars or in the state. Destroyed with the workload, the values are lost and
#   the next apply fails (a function cannot start on a secret with no version).
#   Secret Manager is free up to 6 active versions per billing account. The
#   GitHub App of the self-hosted runners is kept the same way (issue #54):
#   External Secrets copies it into the runners cluster at every deploy, so a
#   destroy -> apply brings the runners back with no `kubectl create secret`.
#
# infra/serverless only reads them (data sources, frontend.tf and secrets.tf);
# it gave them up with `removed` blocks, so its destroy leaves them in place.
# infra/foundation reads the runner ones (runners_secrets.tf).

locals {
  persistent_services = toset([
    "compute.googleapis.com",       # frontend global address
    "secretmanager.googleapis.com", # secret containers
  ])

  discord_secrets = {
    discord-public-key          = "Discord application public key, verifies the Ed25519 signature of interactions"
    discord-bot-token           = "Discord bot token, used by the workers to post follow-ups"
    discord-oauth-client-secret = "Discord OAuth2 client secret of the web login"
  }

  # Only where the runners cluster exists (prd). The names are the ones
  # infra/foundation/runners_secrets.tf reads.
  runner_secrets = var.runners_enabled ? {
    arc-github-app-id              = "App id of the GitHub App the self-hosted runners register with (ARC)"
    arc-github-app-installation-id = "Installation id of that GitHub App on the repository"
    arc-github-app-private-key     = "PEM private key of that GitHub App"
  } : {}

  secrets = merge(local.discord_secrets, local.runner_secrets)
}

resource "google_project_service" "persistent" {
  for_each = local.persistent_services

  project                    = var.project_id
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
}

# Same name as before the move ("frontend"), so the existing address is
# adopted by import.sh and the IP does not change.
resource "google_compute_global_address" "frontend" {
  project = var.project_id
  name    = "frontend"

  depends_on = [google_project_service.persistent]
}

# Containers only. Values are added out of band, for example:
#   printf '%s' "$VALUE" | gcloud secrets versions add discord-bot-token \
#     --project <project_id> --data-file=-
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

  depends_on = [google_project_service.persistent]
}
