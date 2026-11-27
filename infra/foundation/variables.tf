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
  description = "Create the GKE cluster of the self-hosted runners. Only one cluster serves CI (CI_RUNNER and CI_RUNNER_TRUSTED point to its two scale sets), so only dev enables it"
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
    condition     = !var.runners_enabled || (length(var.runners_cluster_name) > 0 && length(var.runners_cluster_name) <= 24)
    error_message = "runners_cluster_name is required when runners_enabled and must be 24 characters or fewer (service account ids are limited to 30)."
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

variable "runners_arc_version" {
  type        = string
  default     = "0.15.1"
  description = "Version of the Actions Runner Controller charts (controller and scale set must match). Bump it on purpose, after reading the ARC release notes"

  validation {
    condition     = can(regex("^[0-9]+[.][0-9]+[.][0-9]+$", var.runners_arc_version))
    error_message = "runners_arc_version must be an exact chart version, e.g. 0.15.1."
  }
}

variable "runners_eso_version" {
  type        = string
  default     = "2.15.0"
  description = "Version of the External Secrets Operator chart that syncs the runners GitHub App secret from Secret Manager. Bump it on purpose, after reading the release notes"

  validation {
    condition     = can(regex("^[0-9]+[.][0-9]+[.][0-9]+$", var.runners_eso_version))
    error_message = "runners_eso_version must be an exact chart version, e.g. 2.15.0."
  }
}

variable "runners_min_runners" {
  type        = number
  default     = 0
  description = "Runner pods kept idle. 0: no runner pod when no job is queued"
}

variable "runners_max_runners" {
  type        = number
  default     = 4
  description = "Maximum number of concurrent runner pods. A runner (runner + dind) requests about 1.5 CPU and 3Gi: raise runners_max_nodes before raising this"

  validation {
    condition     = var.runners_max_runners >= var.runners_min_runners && var.runners_max_runners > 0
    error_message = "runners_max_runners must be positive and at least runners_min_runners."
  }
}

variable "runners_trusted_max_nodes" {
  type        = number
  default     = 1
  description = "Maximum number of nodes of the trusted node pool (jobs holding credentials, never shared with PR jobs). It scales from 0"

  validation {
    condition     = var.runners_trusted_max_nodes > 0
    error_message = "runners_trusted_max_nodes must be positive."
  }
}

variable "runners_trusted_max_runners" {
  type        = number
  default     = 2
  description = "Maximum number of concurrent trusted runner pods (deploy build, release, architecture). An e2-standard-4 node holds 2"

  validation {
    condition     = var.runners_trusted_max_runners > 0
    error_message = "runners_trusted_max_runners must be positive."
  }
}
