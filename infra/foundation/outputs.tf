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

output "runners_subnet_id" {
  value       = google_compute_subnetwork.runners.id
  description = "The id of the subnet reserved for the CI runners"
}

output "runners_subnet_cidr" {
  value       = google_compute_subnetwork.runners.ip_cidr_range
  description = "The IP range of the subnet reserved for the CI runners"
}

output "runners_cluster_name" {
  value       = google_container_cluster.runners.name
  description = "Name of the GKE cluster hosting the CI runners"
}

output "runners_cluster_location" {
  value       = google_container_cluster.runners.location
  description = "Location of the GKE cluster hosting the CI runners"
}
