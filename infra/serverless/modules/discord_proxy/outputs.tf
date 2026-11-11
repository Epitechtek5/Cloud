output "service_account_email" {
  description = "Service account of the proxy: pass it to the Pub/Sub module as publisher of discord.command"
  value       = google_service_account.proxy.email
}

output "url" {
  description = "URL of the function, backend of the API Gateway route (never given to Discord directly)"
  value       = google_cloudfunctions2_function.proxy.service_config[0].uri
}

output "public_key_secret_id" {
  description = "Secret to fill with the Discord application public key"
  value       = google_secret_manager_secret.public_key.secret_id
}
