variable "project_id" {
  type        = string
  description = "GCP project id (the id, not the display name) watched by the budget"
}

variable "environment" {
  type        = string
  description = "Environment name, used in the budget display name"

  validation {
    condition     = contains(["dev", "prd"], var.environment)
    error_message = "environment must be dev or prd."
  }
}

variable "billing_account" {
  type        = string
  description = "Billing account id (XXXXXX-XXXXXX-XXXXXX) linked to the project. Set in <env>.local.tfvars, not committed"

  validation {
    condition     = can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account))
    error_message = "billing_account must look like 012345-6789AB-CDEF01 (gcloud billing projects describe <project_id>)."
  }
}

variable "budget_amount" {
  type        = number
  description = "Monthly budget, in the currency of the billing account"

  validation {
    condition     = var.budget_amount > 0 && floor(var.budget_amount) == var.budget_amount
    error_message = "budget_amount must be a positive whole number."
  }
}

variable "budget_currency" {
  type        = string
  default     = null
  description = "ISO 4217 currency of budget_amount. Null uses the currency of the billing account; if set, it must match it"
}

variable "budget_thresholds" {
  type = list(object({
    percent = number
    basis   = string
  }))
  default = [
    { percent = 0.5, basis = "CURRENT_SPEND" },
    { percent = 0.9, basis = "CURRENT_SPEND" },
    { percent = 1.0, basis = "CURRENT_SPEND" },
    { percent = 1.0, basis = "FORECASTED_SPEND" },
  ]
  description = "Alert thresholds as a fraction of budget_amount (0.5 = 50 %). basis is CURRENT_SPEND (actual) or FORECASTED_SPEND"

  validation {
    condition = length(var.budget_thresholds) > 0 && alltrue([
      for t in var.budget_thresholds :
      t.percent > 0 && contains(["CURRENT_SPEND", "FORECASTED_SPEND"], t.basis)
    ])
    error_message = "Each threshold needs percent > 0 and basis CURRENT_SPEND or FORECASTED_SPEND."
  }
}

variable "notification_emails" {
  type        = list(string)
  description = "Team addresses alerted on every threshold, through Cloud Monitoring email channels (5 at most, an API limit). Set in <env>.local.tfvars, not committed"

  validation {
    condition     = length(var.notification_emails) > 0 && length(var.notification_emails) <= 5
    error_message = "notification_emails must hold between 1 and 5 addresses (a budget accepts 5 notification channels)."
  }
}
