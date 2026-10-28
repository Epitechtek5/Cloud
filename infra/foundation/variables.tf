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

variable "runners_cluster_name" {
  type        = string
  description = "Name of the GKE cluster hosting the self-hosted CI runners"
}

variable "runners_master_cidr" {
  type        = string
  description = "/28 used by GKE for the private control plane; must not overlap any subnet"

  validation {
    condition     = can(cidrhost(var.runners_master_cidr, 0)) && endswith(var.runners_master_cidr, "/28")
    error_message = "runners_master_cidr must be a valid /28 CIDR, e.g. 172.16.0.0/28."
  }
}

variable "runners_authorized_networks" {
  type = list(object({
    cidr_block   = string
    display_name = string
  }))
  default     = []
  description = "Extra networks allowed to reach the cluster control plane (e.g. the admin workstation running Helm)"
}

variable "runners_machine_type" {
  type        = string
  default     = "e2-standard-4"
  description = "Machine type of the runner nodes"
}

variable "runners_min_nodes" {
  type        = number
  default     = 1
  description = "Minimum number of runner nodes per zone (the ARC controller needs one)"
}

variable "runners_max_nodes" {
  type        = number
  default     = 3
  description = "Maximum number of runner nodes per zone, the hard ceiling of the fleet"
}

variable "runners_spot" {
  type        = bool
  default     = true
  description = "Use Spot VMs for the runner nodes (cheaper, may be preempted: acceptable for ephemeral jobs)"
}
