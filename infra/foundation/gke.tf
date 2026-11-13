# GKE cluster that runs the self-hosted GitHub Actions runners (Actions Runner
# Controller, see runners.tf and docs/ci/self-hosted-runners.md). The nodes
# live in the dedicated runners subnet and have no public IP.

resource "google_service_account" "runners_nodes" {
  count = var.runners_enabled ? 1 : 0

  account_id   = "${var.runners_cluster_name}-nodes"
  display_name = "GKE nodes of ${var.runners_cluster_name}"
}

# Predefined role with only what a GKE node needs (logs and metrics).
resource "google_project_iam_member" "runners_nodes" {
  count = var.runners_enabled ? 1 : 0

  # Reading the project IAM policy needs the Cloud Resource Manager API.
  depends_on = [google_project_service.foundation]

  project = var.project_id
  role    = "roles/container.defaultNodeServiceAccount"
  member  = "serviceAccount:${google_service_account.runners_nodes[0].email}"
}

resource "google_container_cluster" "runners" {
  #checkov:skip=CKV_GCP_66:Binary Authorization needs a signed-image pipeline; the runner images are public and pinned by tag
  #checkov:skip=CKV_GCP_65:No Google Groups for RBAC: the cluster has no human users, Kubernetes access goes through the IAM roles of the deploy and plan service accounts
  count = var.runners_enabled ? 1 : 0

  # Nodes must not start before their service account has its role, and the
  # GKE API must be enabled first.
  depends_on = [google_project_iam_member.runners_nodes, google_project_service.foundation]

  name = var.runners_cluster_name
  # Zonal on purpose: a regional cluster would run the node pool in 3 zones
  # (min/max nodes are per zone) and pay the GKE management fee.
  location = var.runners_zone

  network    = google_compute_network.main.id
  subnetwork = google_compute_subnetwork.runners.id

  # The default node pool cannot be configured, so it is created then removed.
  remove_default_node_pool = true
  initial_node_count       = 1

  deletion_protection = false

  # Traffic between pods of the same node goes through the VPC (flow logs).
  enable_intranode_visibility = true
  resource_labels             = { purpose = "ci-runners" }

  release_channel {
    channel = "REGULAR"
  }

  ip_allocation_policy {
    cluster_secondary_range_name  = "runners-pods"
    services_secondary_range_name = "runners-services"
  }

  # Private nodes. The IP-based public endpoint stays, but closed by the
  # authorized networks below.
  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = var.runners_master_cidr
  }

  # Terraform (Helm and Kubernetes providers, see runners.tf) reaches the
  # control plane through the DNS-based endpoint: every request is
  # authenticated and authorized by IAM (container.clusters.connect plus the
  # Kubernetes permissions of the caller), so no source IP has to be allowed.
  # The deploy workflow runs on GitHub-hosted runners, whose IPs are unknown.
  control_plane_endpoints_config {
    dns_endpoint_config {
      allow_external_traffic = true
    }
  }

  # Authorized networks of the IP-based endpoint are managed outside Terraform
  # (see the docs): an admin IP changes often and must not be committed, and a
  # deploy must not reset the list. An empty block still ENABLES authorized
  # networks (with no range): the IP endpoint is closed to the Internet until an
  # admin range is added. Do not remove the block, that would open it.
  master_authorized_networks_config {}

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  # Default for every node pool: pods reach the GKE metadata server only.
  # The temporary default pool also uses the dedicated service account, never
  # the Compute Engine default one (often Editor).
  node_config {
    service_account = google_service_account.runners_nodes[0].email

    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }

  # Dataplane V2 (Cilium) enforces NetworkPolicy natively: no Calico addon.
  datapath_provider = "ADVANCED_DATAPATH"

  master_auth {
    client_certificate_config {
      issue_client_certificate = false
    }
  }

  lifecycle {
    ignore_changes = [
      master_authorized_networks_config,
      # Once the default pool is removed the API returns the config of that
      # first pool, which would otherwise show a diff (some fields are ForceNew)
      # and replace the cluster at every deploy. Side effect: any later change to
      # the cluster's node_config block is ignored silently, change the node pool.
      node_config,
    ]
  }

  logging_config {
    enable_components = ["SYSTEM_COMPONENTS", "WORKLOADS"]
  }

  monitoring_config {
    enable_components = ["SYSTEM_COMPONENTS"]
  }
}

resource "google_container_node_pool" "runners" {
  count = var.runners_enabled ? 1 : 0

  depends_on = [google_project_iam_member.runners_nodes]

  name     = "runners"
  cluster  = google_container_cluster.runners[0].id
  location = var.runners_zone

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
    service_account = google_service_account.runners_nodes[0].email
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
  count = var.runners_enabled ? 1 : 0

  name    = "${var.runners_cluster_name}-router"
  network = google_compute_network.main.id
  region  = var.region
}

resource "google_compute_router_nat" "runners" {
  count = var.runners_enabled ? 1 : 0

  name   = "${var.runners_cluster_name}-nat"
  router = google_compute_router.runners[0].name
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
