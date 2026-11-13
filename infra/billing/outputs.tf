output "budget_id" {
  value       = google_billing_budget.monthly.id
  description = "Budget resource name (billingAccounts/<id>/budgets/<id>)"
}

output "notification_channel_ids" {
  value       = [for c in google_monitoring_notification_channel.email : c.id]
  description = "Cloud Monitoring email channels alerted by the budget"
}
