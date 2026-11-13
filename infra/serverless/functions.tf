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
