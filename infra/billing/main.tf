locals {
  services = toset([
    "billingbudgets.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "monitoring.googleapis.com",
  ])
}

# disable_on_destroy = false: the other stacks also rely on these APIs.
resource "google_project_service" "this" {
  for_each = local.services

  project                    = var.project_id
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
}

# The budget filter wants the project number, not the id.
data "google_project" "this" {
  project_id = var.project_id

  depends_on = [google_project_service.this]
}

resource "google_monitoring_notification_channel" "email" {
  for_each = toset(var.notification_emails)

  project      = var.project_id
  display_name = "Budget alerts - ${each.value}"
  type         = "email"
  labels = {
    email_address = each.value
  }

  depends_on = [google_project_service.this]
}

resource "google_billing_budget" "monthly" {
  billing_account = var.billing_account
  display_name    = "huiledecloud-${var.environment}-monthly"

  budget_filter {
    projects        = ["projects/${data.google_project.this.number}"]
    calendar_period = "MONTH"

    # Free-trial credits pay the whole bill: with credits deducted the spend
    # stays at 0 and no threshold is ever crossed. Excluding them tracks the
    # gross cost, i.e. how fast the credits are being burnt.
    credit_types_treatment = "EXCLUDE_ALL_CREDITS"
  }

  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = tostring(var.budget_amount)
    }
  }

  dynamic "threshold_rules" {
    for_each = var.budget_thresholds

    content {
      threshold_percent = threshold_rules.value.percent
      spend_basis       = threshold_rules.value.basis
    }
  }

  all_updates_rule {
    monitoring_notification_channels = [for c in google_monitoring_notification_channel.email : c.id]
    # Billing account admins and users keep getting the default emails too.
    disable_default_iam_recipients = false
  }

  depends_on = [google_project_service.this]
}
