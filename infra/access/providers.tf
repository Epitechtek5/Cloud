terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}

# Applied by a project Owner with `gcloud auth application-default login`:
# never by the pipeline, whose identities this stack defines.
provider "google" {
  project = var.project_id
}

# Authenticates with the GITHUB_TOKEN environment variable, set from the
# applier's own GitHub CLI session (`export GITHUB_TOKEN="$(gh auth token)"`):
# no token is stored in the repository nor in a GitHub secret.
provider "github" {
  owner = split("/", var.github_repository)[0]
}
