terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}

# The Budget API refuses end-user credentials without a quota project
# ("Your application is authenticating by using local Application Default
# Credentials..."). user_project_override sends var.project_id as the quota
# project on every call, so `gcloud auth application-default login` is enough.
provider "google" {
  project               = var.project_id
  billing_project       = var.project_id
  user_project_override = true
}
