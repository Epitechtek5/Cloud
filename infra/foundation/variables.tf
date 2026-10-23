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
