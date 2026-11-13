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

# --- People (humans.tf) ---------------------------------------------------------

variable "team_members" {
  type        = map(string)
  description = "Team members granted Owner, as short name => Google account email. Set in <env>.local.tfvars, not committed"

  validation {
    condition     = length(var.team_members) > 0 && alltrue([for email in values(var.team_members) : can(regex("^[^@ ]+@[^@ ]+$", email))])
    error_message = "team_members needs at least one entry, each an email address (an empty map would lock the team out)."
  }
}

variable "instructor_email" {
  type        = string
  default     = "jeremie@jjaouen.com"
  description = "Google account of the instructor: Editor on the project, billing viewer on the billing account (subject C01 §4.3)"
}

variable "billing_account" {
  type        = string
  default     = null
  description = "Billing account id (XXXXXX-XXXXXX-XXXXXX) of the projects, for the instructor billing viewer grant. prd only, needs a Billing Account Administrator; null leaves the grant out. Set in prd.local.tfvars, not committed"

  validation {
    condition     = var.billing_account == null || can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account))
    error_message = "billing_account must look like 012345-6789AB-CDEF01 (gcloud billing projects describe <project_id>)."
  }
}

# GitHub logins are public (commits, contributors), unlike the emails above.
variable "github_collaborators" {
  type = map(string)
  default = {
    Zeishy         = "admin"
    Raphael-Clenet = "admin"
    Quentintnrl    = "admin"
    Kloox          = "pull" # instructor, read-only (subject C01 §3.1)
  }
  description = "Direct collaborators of github_repository, as login => permission (pull, triage, push, maintain, admin). Managed by the prd state only"

  validation {
    condition     = alltrue([for p in values(var.github_collaborators) : contains(["pull", "triage", "push", "maintain", "admin"], p)])
    error_message = "Each permission must be pull, triage, push, maintain or admin."
  }
}
