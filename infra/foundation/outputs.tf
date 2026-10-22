output "vpc_id" {
  value       = google_compute_network.main.id
  description = "The id of the created VPC network"
}

output "subnet_id" {
  value       = google_compute_subnetwork.main.id
  description = "The id of the created subnet"
}

output "subnet_cidr" {
  value       = google_compute_subnetwork.main.ip_cidr_range
  description = "The IP range of the created subnet"
}
