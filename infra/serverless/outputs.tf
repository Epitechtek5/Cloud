# Contract with deploy-env.yml: the smoke test curls this URL after the apply.
# It is also the Discord OAuth2 redirect and the target of the Activity "/" mapping.
output "app_url" {
  value       = "https://${local.frontend_domain}/"
  description = "Public HTTPS URL of the web app (load balancer and Cloud CDN in front of the frontend bucket)"
}

output "frontend_ip" {
  value       = google_compute_global_address.frontend.address
  description = "IP of the frontend load balancer (A record of frontend_domain when a domain is used)"
}

output "health_url" {
  value       = module.health.uri
  description = "Liveness function, public until the API Gateway lands (#60)"
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

output "pubsub_topics" {
  value       = module.pubsub.topics
  description = "Pub/Sub topic ids by channel name"
}

output "pubsub_dlq_subscriptions" {
  value       = module.pubsub.dlq_subscriptions
  description = "Dead-letter pull subscriptions by channel name (inspect and replay failed messages)"
}
