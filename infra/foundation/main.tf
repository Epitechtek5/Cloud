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

  log_config {
    aggregation_interval = "INTERVAL_10_MIN"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

# Hosts the self-hosted CI runners (GKE nodes), kept apart from the
# workload subnet so their firewall rules and routes stay independent.
resource "google_compute_subnetwork" "runners" {
  name          = "${var.vpc_name}-runners"
  network       = google_compute_network.main.id
  region        = var.region
  ip_cidr_range = cidrsubnet(var.cidr_block, 8, 2) # 10.0.0.0/16 -> 10.0.2.0/24

  private_ip_google_access = true

  # Alias IP ranges of the GKE cluster that hosts the runners (see gke.tf).
  secondary_ip_range {
    range_name    = "runners-pods"
    ip_cidr_range = cidrsubnet(var.cidr_block, 4, 2) # 10.0.0.0/16 -> 10.0.32.0/20
  }

  secondary_ip_range {
    range_name    = "runners-services"
    ip_cidr_range = cidrsubnet(var.cidr_block, 8, 3) # 10.0.0.0/16 -> 10.0.3.0/24
  }

  log_config {
    aggregation_interval = "INTERVAL_10_MIN"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

# Explicit deny-all ingress at the lowest priority: nothing reaches the VPC
# until a more specific allow rule (lower priority number) is added.
resource "google_compute_firewall" "deny_all_ingress" {
  name      = "${var.vpc_name}-deny-all-ingress"
  network   = google_compute_network.main.id
  direction = "INGRESS"
  priority  = 65534

  deny {
    protocol = "all"
  }

  source_ranges = ["0.0.0.0/0"]
}
