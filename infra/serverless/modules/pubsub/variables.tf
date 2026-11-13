variable "project_id" {
  type        = string
  description = "GCP project that owns the topics (used to find the Pub/Sub service agent)"
}

variable "labels" {
  type        = map(string)
  default     = {}
  description = "Labels applied to every topic and subscription"
}

variable "publishers" {
  type        = map(list(string))
  default     = {}
  description = <<-EOT
    Service account emails allowed to publish, by channel name. Each one gets
    pubsub.publisher on THAT topic only (never at project level), so a function
    cannot publish to a topic it does not own.
  EOT
}

variable "push" {
  type = map(object({
    endpoint        = string
    service_account = string
    audience        = optional(string)
  }))
  default     = {}
  description = <<-EOT
    Push delivery of a channel to its worker, by channel name. Leave a channel out
    until its worker exists: its subscription is then a pull one. Messages are
    pushed with an OIDC token minted for service_account (no public invocation);
    audience defaults to the endpoint.
  EOT

  validation {
    condition     = alltrue([for c in values(var.push) : startswith(c.endpoint, "https://")])
    error_message = "push endpoints must be https:// URLs."
  }
}
