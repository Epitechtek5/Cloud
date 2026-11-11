variable "project_id" {
  type        = string
  description = "GCP project of the environment"
}

variable "region" {
  type        = string
  description = "Region of the function"
}

variable "name" {
  type        = string
  default     = "discord-proxy"
  description = "Name of the function; also the prefix of its service account id"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,24}$", var.name))
    error_message = "name must be 5 to 25 lowercase letters, digits or dashes (service account id limit)."
  }
}

variable "source_bucket" {
  type        = string
  description = "Bucket holding the functions package (functions.zip built by deploy.yml)"
}

variable "source_object" {
  type        = string
  description = "Object of the functions package in source_bucket; a new object name redeploys the function"
}

variable "public_key_secret_id" {
  type        = string
  default     = "discord-public-key"
  description = "Secret Manager secret holding the hex public key of the environment's Discord application (value added out of band)"
}

variable "invoker_members" {
  type        = list(string)
  default     = []
  description = "Members allowed to invoke the function: only the API Gateway service account. Never allUsers."

  validation {
    condition     = alltrue([for m in var.invoker_members : !contains(["allUsers", "allAuthenticatedUsers"], m)])
    error_message = "The function must not be publicly invokable: go through the API Gateway."
  }
}

variable "max_instances" {
  type        = number
  default     = 5
  description = "Upper bound of instances (cost guard)"
}

variable "build_service_account" {
  type        = string
  default     = null
  description = "Service account id used by Cloud Build to build the function (null = project default)"
}

variable "labels" {
  type        = map(string)
  default     = {}
  description = "Labels of the function and the secret"
}
