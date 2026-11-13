terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}

# Applied by a project Owner with `gcloud auth application-default login`:
# never by the pipeline, whose identities this stack defines.
provider "google" {
  project = var.project_id
}
