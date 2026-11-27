output "dashboard_id" {
  value       = google_monitoring_dashboard.this.id
  description = "Dashboard resource id"
}

output "dashboard_url" {
  value       = "https://console.cloud.google.com/monitoring/dashboards/builder/${element(split("/", google_monitoring_dashboard.this.id), 3)}?project=${var.project_id}"
  description = "Console URL of the dashboard"
}

output "charts" {
  value       = [for c in local.charts : c.title]
  description = "Titles of the charts (used by the tests)"
}
