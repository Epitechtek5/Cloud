# Contract with deploy-env.yml: the smoke test curls this URL after the apply.
output "app_url" {
  value       = module.health.uri
  description = "Public HTTPS entry point of the application (the health function until the API Gateway lands)"
}

output "functions_source_bucket" {
  value       = google_storage_bucket.functions_source.name
  description = "Bucket holding the zipped function sources"
}

output "functions_docker_repository" {
  value       = google_artifact_registry_repository.functions.id
  description = "Artifact Registry repository of the function images"
}

output "functions_build_service_account" {
  value       = google_service_account.functions_build.id
  description = "Service account Cloud Build uses to build the functions"
}

output "secret_ids" {
  value       = { for k, s in google_secret_manager_secret.this : k => s.id }
  description = "Secret Manager containers, keyed by secret id (values are added out of band)"
}
