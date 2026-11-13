# The two identities of the pipeline, and who may impersonate them.

resource "google_service_account" "deploy" {
  project      = var.project_id
  account_id   = "gha-deploy"
  display_name = "GitHub Actions deploy (${var.environment})"
  description  = "deploy-env.yml, destroy.yml, architecture.yml in the ${var.environment} GitHub Environment (infra/access)"
}

resource "google_service_account" "plan" {
  project      = var.project_id
  account_id   = "gha-plan"
  display_name = "GitHub Actions plan (read-only)"
  description  = "ci-terraform.yml plan on pull requests, read-only (infra/access)"
}

# Deploy: only jobs of this repository running in the GitHub Environment of the
# same name (prd has required reviewers). The subject is matched exactly.
# GitHub sends one of two subject formats depending on the repository OIDC
# setting (`gh api repos/<repo>/actions/oidc/customization/sub`): both are
# bound, both carry the environment.
locals {
  deploy_subjects = toset([
    "repo:${var.github_repository}:environment:${var.environment}",
    "repo:${replace(var.github_repository, "/", "@${var.github_repository_owner_id}/")}@${var.github_repository_id}:environment:${var.environment}",
  ])
}

resource "google_service_account_iam_member" "deploy_wif" {
  for_each = local.deploy_subjects

  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${local.pool_name}/subject/${each.value}"
}

# Plan: any job of the repository (pull requests have no Environment, so a
# plan never waits for the prd reviewers). The account is read-only.
resource "google_service_account_iam_member" "plan_wif" {
  service_account_id = google_service_account.plan.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.pool_name}/attribute.repository/${var.github_repository}"
}
