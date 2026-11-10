variable "project_id" {
  type        = string
  description = "GCP project id (the id, not the display name)"
}

variable "region" {
  type        = string
  description = "Region for regional resources (subnets, ...)"
}

variable "vpc_name" {
  type        = string
  description = "Name of the VPC network"
}

variable "cidr_block" {
  type        = string
  description = "Address space reserved for the VPC; subnets are carved out of it"

  validation {
    condition     = can(cidrhost(var.cidr_block, 0))
    error_message = "cidr_block must be a valid CIDR, e.g. 10.0.0.0/16."
  }
}

variable "runners_enabled" {
  type        = bool
  default     = false
  description = "Create the GKE cluster of the self-hosted runners. Only one cluster serves CI (CI_RUNNER points to a single scale set), so only dev enables it"
}

variable "runners_zone" {
  type        = string
  default     = ""
  description = "Zone of the (zonal) runners cluster, e.g. europe-west1-b; required when runners_enabled"

  validation {
    condition     = !var.runners_enabled || startswith(var.runners_zone, "${var.region}-")
    error_message = "runners_zone must be a zone of var.region (e.g. europe-west1-b for europe-west1)."
  }
}

variable "runners_cluster_name" {
  type        = string
  default     = ""
  description = "Name of the GKE cluster hosting the self-hosted CI runners (24 characters max: the node service account id adds -nodes)"

  validation {
    condition     = length(var.runners_cluster_name) <= 24
    error_message = "runners_cluster_name must be 24 characters or fewer (service account ids are limited to 30)."
  }
}

variable "runners_master_cidr" {
  type        = string
  default     = "172.16.0.0/28"
  description = "/28 used by GKE for the private control plane; must not overlap any subnet"

  validation {
    condition     = can(cidrhost(var.runners_master_cidr, 0)) && endswith(var.runners_master_cidr, "/28")
    error_message = "runners_master_cidr must be a valid /28 CIDR, e.g. 172.16.0.0/28."
  }
}

variable "runners_machine_type" {
  type        = string
  default     = "e2-standard-4"
  description = "Machine type of the runner nodes"
}

variable "runners_min_nodes" {
  type        = number
  default     = 1
  description = "Minimum number of runner nodes (the ARC controller needs one)"
}

variable "runners_max_nodes" {
  type        = number
  default     = 3
  description = "Maximum number of runner nodes, the hard ceiling of the fleet"
}

variable "runners_spot" {
  type        = bool
  default     = true
  description = "Use Spot VMs for the runner nodes (cheaper, may be preempted: acceptable for ephemeral jobs)"
}
