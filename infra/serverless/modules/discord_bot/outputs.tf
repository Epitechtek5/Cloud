output "bot_token_secret_id" {
  description = "Secret to fill with the bot token of the Discord application"
  value       = google_secret_manager_secret.bot_token.secret_id
}
