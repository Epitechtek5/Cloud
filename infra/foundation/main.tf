# On GCP a VPC is global and has no CIDR of its own: only subnets carry IP ranges.
# var.cidr_block is the envelope we reserve for this environment, and each
# subnet is carved out of it with cidrsubnet().
resource "google_compute_network" "main" {
  name                    = var.vpc_name
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

resource "google_compute_subnetwork" "main" {
  name          = "${var.vpc_name}-subnet"
  network       = google_compute_network.main.id
  region        = var.region
  ip_cidr_range = cidrsubnet(var.cidr_block, 8, 1) # 10.0.0.0/16 -> 10.0.1.0/24

  private_ip_google_access = true
}
