variable "project_id" {
  type        = string
  description = "GCP project id (the id, not the display name)"
}

variable "region" {
  type        = string
  description = "Region of the functions, buckets and repositories"
}

variable "env" {
  type        = string
  description = "Environment name, used in labels and resource names"

  validation {
    condition     = contains(["dev", "prd"], var.env)
    error_message = "env must be dev or prd."
  }
}

variable "app_artifact_dir" {
  type        = string
  default     = ""
  description = "Directory of the pipeline build artifact (functions.zip, frontend/). Set by deploy-env.yml through TF_VAR_app_artifact_dir. When empty or without functions.zip (PR plans, destroy), the zip is built from app/functions/src"
}

variable "functions_runtime" {
  type        = string
  default     = "nodejs22"
  description = "Runtime of every function (matches the Node version of the pipeline build)"
}

# Frontend (#70): the domain, and the values of the generated /config.json (all public).
variable "frontend_domain" {
  type        = string
  default     = null
  description = "Domain of the front, with a DNS A record to the frontend_ip output. Null: <ip-with-dashes>.sslip.io, derived from the load balancer IP"
}

variable "api_base_url" {
  type        = string
  default     = ""
  description = "apiBase of config.json: https URL of the API Gateway (#60), or a same-origin path. Empty until the gateway exists"

  validation {
    condition     = var.api_base_url == "" || can(regex("^(https://[^/?#\\s]+(/[^?#\\s]*)?|/[^/?#\\s][^?#\\s]*)$", var.api_base_url))
    error_message = "api_base_url must be an https URL or a same-origin path (/api), without query or fragment."
  }
}

variable "discord_client_id" {
  type        = string
  default     = ""
  description = "Public id of the Discord application of this environment (one application per environment)"

  validation {
    condition     = can(regex("^[0-9]*$", var.discord_client_id))
    error_message = "discord_client_id is the numeric id of the Discord application."
  }
}

variable "firebase_api_key" {
  type        = string
  default     = ""
  description = "Firebase Web API key of this project (a public identifier, not a secret). Empty until the Firebase web app exists"
}
