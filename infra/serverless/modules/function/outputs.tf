output "uri" {
  value       = google_cloudfunctions2_function.this.service_config[0].uri
  description = "HTTPS URL of the function (reachable only by var.invokers)"
}

output "service_name" {
  value       = google_cloudfunctions2_function.this.service_config[0].service
  description = "Underlying Cloud Run service, for extra IAM bindings"
}

output "service_account_email" {
  value       = google_service_account.this.email
  description = "Identity of the function, to grant it access to topics, buckets or Firestore"
}
