# Module only: the provider configuration (project, region) and the backend
# belong to the calling stack (infra/serverless, see the stack bootstrap issue).
terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}
