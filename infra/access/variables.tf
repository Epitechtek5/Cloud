variable "project_id" {
  type        = string
  description = "GCP project id (the id, not the display name) of the environment"
}

variable "environment" {
  type        = string
  description = "Environment name. It is also the name of the GitHub Environment allowed to use the deploy account"

  validation {
    condition     = contains(["dev", "prd"], var.environment)
    error_message = "environment must be dev or prd."
  }
}

variable "state_bucket" {
  type        = string
  description = "Terraform state bucket of the environment (created by scripts/bootstrap-state-bucket.sh)"
}

variable "github_repository" {
  type        = string
  default     = "Epitechtek5/Cloud"
  description = "owner/name of the only GitHub repository allowed to authenticate"
}

# The ids never change, unlike the names: a repository deleted or renamed, then
# re-created under the same name by someone else, gets other ids and is refused.
# gh api repos/<owner>/<name> --jq '[.owner.id, .id]'
variable "github_repository_owner_id" {
  type        = string
  default     = "345497600"
  description = "Numeric id of the GitHub organization owning github_repository"
}

variable "github_repository_id" {
  type        = string
  default     = "1429506566"
  description = "Numeric id of github_repository"
}
