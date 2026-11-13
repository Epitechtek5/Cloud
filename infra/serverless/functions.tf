# Every function of the application is an instance of modules/function. The
# business functions (proxies, workers) are added by their own issues.

# Liveness endpoint behind `app_url`, checked by the deploy smoke test.
# Temporary exception to "no function reachable from the internet": until the
# API Gateway exists (#60) the smoke test has nothing else to call, and this
# function only returns "ok". #60 moves `app_url` to the gateway and drops
# `allUsers` here.
module "health" {
  source = "./modules/function"

  project_id  = var.project_id
  region      = var.region
  name        = "health"
  description = "Liveness endpoint used by the deploy smoke test"
  runtime     = var.functions_runtime
  entry_point = "hello"

  source_bucket            = google_storage_bucket.functions_source.name
  source_object            = google_storage_bucket_object.functions_source.name
  docker_repository        = google_artifact_registry_repository.functions.id
  build_service_account_id = google_service_account.functions_build.id

  ingress       = "ALLOW_ALL"
  invokers      = ["allUsers"]
  max_instances = 1

  depends_on = [
    google_project_iam_member.functions_build_logs,
    google_project_iam_member.functions_build_sources,
    google_artifact_registry_repository_iam_member.functions_build,
  ]
}

# Discord interactions proxy (#62): verifies the Ed25519 signature, answers
# PING, publishes slash commands on `discord.command` (publisher binding in
# pubsub.tf) and returns a deferred response. Code: app/functions/src/discord.
# The public key comes from Secret Manager (`discord-public-key`, value added
# out of band). No allUsers: only the API Gateway service account will be an
# invoker (#60); until then the function cannot be called from outside.
# Deployed only once `discord_proxy_enabled` is true in <env>.tfvars: Cloud Run
# cannot start a revision whose secret has no version, and the first apply of
# an environment creates the secret empty (see docs/discord-bot.md).
module "discord_proxy" {
  source = "./modules/function"
  count  = var.discord_proxy_enabled ? 1 : 0

  project_id  = var.project_id
  region      = var.region
  name        = "discord-proxy"
  description = "Verifies Discord interactions, publishes discord.command and defers the answer"
  runtime     = var.functions_runtime
  entry_point = "discordProxy"

  source_bucket            = google_storage_bucket.functions_source.name
  source_object            = google_storage_bucket_object.functions_source.name
  docker_repository        = google_artifact_registry_repository.functions.id
  build_service_account_id = google_service_account.functions_build.id

  secret_env = {
    DISCORD_PUBLIC_KEY = google_secret_manager_secret.this["discord-public-key"].secret_id
  }

  # Called by the API Gateway from outside the VPC, still behind roles/run.invoker.
  ingress  = "ALLOW_ALL"
  invokers = var.gateway_invokers
  # Discord waits 3 s: the proxy only verifies, publishes and answers.
  timeout_seconds = 10
  max_instances   = 5

  depends_on = [
    google_project_iam_member.functions_build_logs,
    google_project_iam_member.functions_build_sources,
    google_artifact_registry_repository_iam_member.functions_build,
  ]
}
