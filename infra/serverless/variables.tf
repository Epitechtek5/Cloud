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
