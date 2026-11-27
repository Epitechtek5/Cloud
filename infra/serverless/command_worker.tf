# Command worker (#64): consumes discord.command (push subscription with retry
# and DLQ, pubsub.tf), performs the slash command and edits the deferred
# response through the interaction token (no bot token needed). Code in
# app/functions/src/commands, documented in docs/discord-bot.md.
#
# Admin authorization is enforced here, not in Discord: only the role ids and
# user ids below may run /admin. Public ids, not secrets. Both
# lists empty: nobody is admin (the worker fails closed).

variable "discord_admin_role_ids" {
  type        = list(string)
  default     = []
  description = "Discord role ids whose members may run /admin (the guild's canvas admin role)"

  validation {
    condition     = alltrue([for id in var.discord_admin_role_ids : can(regex("^[0-9]{17,20}$", id))])
    error_message = "discord_admin_role_ids must be Discord snowflakes (17 to 20 digits)."
  }
}

variable "discord_admin_user_ids" {
  type        = list(string)
  default     = []
  description = "Discord user ids allowed to run /admin whatever their roles (allow-list)"

  validation {
    condition     = alltrue([for id in var.discord_admin_user_ids : can(regex("^[0-9]{17,20}$", id))])
    error_message = "discord_admin_user_ids must be Discord snowflakes (17 to 20 digits)."
  }
}

# Identity Pub/Sub signs the push requests (OIDC) with; the only invoker of the
# worker. It has no other role.
resource "google_service_account" "command_push" {
  project      = var.project_id
  account_id   = "push-command-worker"
  display_name = "Pub/Sub push to command-worker"
  description  = "Signs the push requests of discord.command.sub to the command worker"
}

module "command_worker" {
  source = "./modules/function"

  project_id  = var.project_id
  region      = var.region
  name        = "command-worker"
  description = "Performs the Discord slash commands (discord.command) and answers the interaction"
  runtime     = var.functions_runtime
  entry_point = "commandWorker"

  source_bucket            = google_storage_bucket.functions_source.name
  source_object            = google_storage_bucket_object.functions_source.name
  docker_repository        = google_artifact_registry_repository.functions.id
  build_service_account_id = google_service_account.functions_build.id

  environment_variables = {
    ADMIN_ROLE_IDS = jsonencode(var.discord_admin_role_ids)
    ADMIN_USER_IDS = jsonencode(var.discord_admin_user_ids)
    APP_URL        = "https://${local.frontend_domain}/"
  }

  # Pub/Sub push is internal traffic: no gateway, no public URL.
  ingress  = "ALLOW_INTERNAL_ONLY"
  invokers = [google_service_account.command_push.member]
  # Within the 60 s ack deadline of discord.command (/get reads up to 9 tiles).
  timeout_seconds = 55
  memory          = "512M"
  max_instances   = 5

  depends_on = [
    time_sleep.functions_build_iam,
  ]
}

# session/state, users/{uid} and processedCommands. Firestore has no
# per-collection IAM, hence the project-level role (in deploy_grantable_roles).
resource "google_project_iam_member" "command_worker_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${module.command_worker.service_account_email}"
}

output "command_worker_uri" {
  value       = module.command_worker.uri
  description = "Private endpoint of the command worker (push target of discord.command.sub)"
}
