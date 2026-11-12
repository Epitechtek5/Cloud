terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.1"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Short-lived OAuth token of the identity running Terraform (gha-deploy on a
# deploy, gha-plan on a PR plan): no kubeconfig file, no long-lived credential.
data "google_client_config" "current" {}

# The runners cluster is reached through its DNS-based endpoint: access is
# checked by IAM (container.clusters.connect), so the GitHub-hosted runners of
# the deploy workflow get in without being in the authorized networks. The
# endpoint serves a publicly trusted certificate, hence no cluster CA here.
# Null where the cluster does not exist (prd): no Kubernetes resource is
# created there, so these providers are never used.
locals {
  runners_api_host = var.runners_enabled ? "https://${google_container_cluster.runners[0].control_plane_endpoints_config[0].dns_endpoint_config[0].endpoint}" : null
}

provider "kubernetes" {
  host  = local.runners_api_host
  token = data.google_client_config.current.access_token
}

provider "helm" {
  # Releases are recorded in ConfigMaps instead of Secrets: the PR plan account
  # (roles/viewer) may read ConfigMaps but not Secrets. The values hold no
  # credential (the GitHub App key stays in its own Secret).
  helm_driver = "configmap"

  kubernetes = {
    host  = local.runners_api_host
    token = data.google_client_config.current.access_token
  }
}
