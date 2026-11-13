terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
    # google_api_gateway_* only exist in the beta provider (same version as google).
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 7.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region

  default_labels = {
    env        = var.env
    stack      = "serverless"
    managed-by = "terraform"
  }
}

provider "google-beta" {
  project = var.project_id
  region  = var.region

  default_labels = {
    env        = var.env
    stack      = "serverless"
    managed-by = "terraform"
  }
}
