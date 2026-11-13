# Read by scripts/publish-github-variables.sh. Nothing here is a secret.

output "workload_identity_provider" {
  value       = google_iam_workload_identity_pool_provider.github.name
  description = "Full name of the GitHub OIDC provider (google-github-actions/auth workload_identity_provider)"
}

output "deploy_service_account" {
  value       = google_service_account.deploy.email
  description = "gha-deploy: deploy, destroy and architecture jobs of the matching GitHub Environment"
}

output "plan_service_account" {
  value       = google_service_account.plan.email
  description = "gha-plan: read-only PR plan"
}

output "state_bucket" {
  value       = var.state_bucket
  description = "Terraform state bucket of the environment"
}
