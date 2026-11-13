variable "project_id" {
  type        = string
  description = "GCP project id"
}

variable "region" {
  type        = string
  description = "Region of the function"
}

variable "name" {
  type        = string
  description = "Function name, also used for its service account (fn-<name>)"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,24}[a-z0-9]$", var.name))
    error_message = "name must be lowercase letters, digits and dashes, 2 to 26 characters (the service account id fn-<name> is limited to 30)."
  }
}

variable "description" {
  type        = string
  description = "What the function does (one job, see the Single Responsibility Principle)"
}

variable "runtime" {
  type        = string
  description = "Cloud Run functions runtime, e.g. nodejs22"
}

variable "entry_point" {
  type        = string
  description = "Exported function name in the source"
}

variable "source_bucket" {
  type        = string
  description = "Bucket holding the zipped source"
}

variable "source_object" {
  type        = string
  description = "Object name of the zipped source in source_bucket"
}

variable "docker_repository" {
  type        = string
  description = "Artifact Registry repository id receiving the built image"
}

variable "build_service_account_id" {
  type        = string
  description = "Full id (projects/<p>/serviceAccounts/<email>) of the service account Cloud Build uses"
}

variable "environment_variables" {
  type        = map(string)
  default     = {}
  description = "Plain environment variables (never secrets, use secret_env)"
}

variable "secret_env" {
  type        = map(string)
  default     = {}
  description = "Environment variable name => Secret Manager secret id. The function's service account gets secretAccessor on each of these secrets only"
}

variable "pubsub_topic" {
  type        = string
  default     = null
  description = "Full topic id (projects/<p>/topics/<t>) triggering the function. Null for an HTTP function"
}

variable "ingress" {
  type        = string
  default     = "ALLOW_INTERNAL_ONLY"
  description = "ALLOW_INTERNAL_ONLY for workers (Pub/Sub push stays internal); ALLOW_ALL for functions called by the API Gateway, which still needs IAM"

  validation {
    condition     = contains(["ALLOW_ALL", "ALLOW_INTERNAL_ONLY", "ALLOW_INTERNAL_AND_GCLB"], var.ingress)
    error_message = "ingress must be ALLOW_ALL, ALLOW_INTERNAL_ONLY or ALLOW_INTERNAL_AND_GCLB."
  }
}

variable "invokers" {
  type        = list(string)
  default     = []
  description = "IAM members allowed to invoke the function (roles/run.invoker), e.g. the API Gateway service account"
}

variable "memory" {
  type        = string
  default     = "256M"
  description = "Memory of one instance"
}

variable "timeout_seconds" {
  type        = number
  default     = 60
  description = "Request timeout"
}

variable "min_instances" {
  type        = number
  default     = 0
  description = "Minimum instances (0 scales to zero)"
}

variable "max_instances" {
  type        = number
  default     = 3
  description = "Maximum instances, the cost ceiling of the function"
}
