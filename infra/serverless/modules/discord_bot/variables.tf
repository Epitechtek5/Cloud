variable "project_id" {
  type        = string
  description = "GCP project of the environment"
}

variable "bot_token_secret_id" {
  type        = string
  default     = "discord-bot-token"
  description = "Secret Manager secret holding the bot token (value added out of band)"
}

variable "registrar_members" {
  type        = list(string)
  description = "Members allowed to read the token to register the commands: the deploy service account of the environment"

  validation {
    condition     = length(var.registrar_members) > 0 && alltrue([for m in var.registrar_members : startswith(m, "serviceAccount:")])
    error_message = "registrar_members must list service accounts (serviceAccount:...), never users or allUsers."
  }
}

variable "labels" {
  type        = map(string)
  default     = {}
  description = "Labels of the secret"
}
