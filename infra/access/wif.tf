# Keyless GitHub Actions -> GCP authentication (Workload Identity Federation).
# A job presents its GitHub OIDC token, STS exchanges it for a federated token,
# which may impersonate gha-deploy or gha-plan for one hour. No service account
# key exists anywhere.

locals {
  services = toset([
    "cloudresourcemanager.googleapis.com", # project IAM bindings
    "iam.googleapis.com",                  # pool, provider, service accounts, custom roles
    "iamcredentials.googleapis.com",       # short-lived access tokens of the service accounts
    "sts.googleapis.com",                  # OIDC token -> federated token exchange
  ])

  pool_name = google_iam_workload_identity_pool.github.name
}

# disable_on_destroy = false: every stack and every pipeline relies on these.
resource "google_project_service" "this" {
  for_each = local.services

  project                    = var.project_id
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"

  depends_on = [google_project_service.this]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  #checkov:skip=CKV_GCP_125:The pool also serves PR plans, whose sub varies per PR: the condition pins the repository by name and ids plus the environment, and the exact sub is enforced on the gha-deploy binding
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }

  # Checked on every token exchange, before any IAM binding:
  # 1. the repository, by name and by its immutable ids (a deleted or renamed
  #    repository re-created under the same name is refused);
  # 2. the environment: a job running in a GitHub Environment is only accepted
  #    by the pool of that environment. A `prd` job never gets a token from the
  #    dev project, a `dev` job never from the prd project. Jobs without an
  #    Environment (PR plan) stay accepted: they can only reach gha-plan.
  # `sub` always exists (unlike `environment`) and ends with
  # `:environment:<name>` for an Environment job, whatever the subject format
  # (`repo:<owner>/<repo>:...` or `repo:<owner>@<id>/<repo>@<id>:...`).
  attribute_condition = join(" && ", [
    "assertion.repository == '${var.github_repository}'",
    "assertion.repository_owner_id == '${var.github_repository_owner_id}'",
    "assertion.repository_id == '${var.github_repository_id}'",
    "(!assertion.sub.contains(':environment:') || assertion.sub.endsWith(':environment:${var.environment}'))",
  ])
}
