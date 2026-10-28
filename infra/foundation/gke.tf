# GKE cluster that runs the self-hosted GitHub Actions runners (Actions Runner
# Controller, see k8s/runners and docs/ci/self-hosted-runners.md). The nodes
# live in the dedicated runners subnet and have no public IP.

resource "google_service_account" "runners_nodes" {
  account_id   = "${var.runners_cluster_name}-nodes"
  display_name = "GKE nodes of ${var.runners_cluster_name}"
}

# Only what a GKE node needs to log, export metrics and pull images.
resource "google_project_iam_member" "runners_nodes" {
  for_each = toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/monitoring.viewer",
    "roles/stackdriver.resourceMetadata.writer",
    "roles/artifactregistry.reader",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.runners_nodes.email}"
}

resource "google_container_cluster" "runners" {
  name     = var.runners_cluster_name
  location = var.region

  network    = google_compute_network.main.id
  subnetwork = google_compute_subnetwork.runners.id

  # The default node pool cannot be configured, so it is created then removed.
  remove_default_node_pool = true
  initial_node_count       = 1

  deletion_protection = false
  resource_labels     = { purpose = "ci-runners" }

  release_channel {
    channel = "REGULAR"
  }

  ip_allocation_policy {
    cluster_secondary_range_name  = "runners-pods"
    services_secondary_range_name = "runners-services"
  }

  # Private nodes; the control plane keeps a public endpoint so that Helm can
  # reach it, but only from the authorized networks below.
  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = var.runners_master_cidr
  }

  master_authorized_networks_config {
    cidr_blocks {
      cidr_block   = google_compute_subnetwork.runners.ip_cidr_range
      display_name = "runners-subnet"
    }

    dynamic "cidr_blocks" {
      for_each = var.runners_authorized_networks
      content {
        cidr_block   = cidr_blocks.value.cidr_block
        display_name = cidr_blocks.value.display_name
      }
    }
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  network_policy {
    enabled  = true
    provider = "CALICO"
  }

  addons_config {
    network_policy_config {
      disabled = false
    }
  }

  master_auth {
    client_certificate_config {
      issue_client_certificate = false
    }
  }

  logging_config {
    enable_components = ["SYSTEM_COMPONENTS", "WORKLOADS"]
  }

  monitoring_config {
    enable_components = ["SYSTEM_COMPONENTS"]
  }
}

resource "google_container_node_pool" "runners" {
  name     = "runners"
  cluster  = google_container_cluster.runners.id
  location = var.region

  # Hard ceiling on the fleet: the autoscaler can never create more nodes than
  # this, whatever the number of queued jobs.
  autoscaling {
    min_node_count = var.runners_min_nodes
    max_node_count = var.runners_max_nodes
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  node_config {
    machine_type    = var.runners_machine_type
    spot            = var.runners_spot
    service_account = google_service_account.runners_nodes.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    labels          = { purpose = "ci-runners" }

    # Pods must never reach the node metadata server with the node identity.
    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }
  }
}

# Private nodes have no public IP: Cloud NAT gives them outbound access to
# github.com (runner registration, job logs) for the runners subnet only.
resource "google_compute_router" "runners" {
  name    = "${var.runners_cluster_name}-router"
  network = google_compute_network.main.id
  region  = var.region
}

resource "google_compute_router_nat" "runners" {
  name   = "${var.runners_cluster_name}-nat"
  router = google_compute_router.runners.name
  region = var.region

  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"

  subnetwork {
    name                    = google_compute_subnetwork.runners.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}
