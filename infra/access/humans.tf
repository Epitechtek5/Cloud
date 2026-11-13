# People: the team, the instructor, and who may reach the repository. Like the
# rest of this stack it is applied by a project Owner and never by destroy.yml,
# so destroying the workload never locks anyone out. Every role is explained in
# README.md "People".

locals {
  # The repository and the billing account are shared by dev and prd: only the
  # prd state manages them, so two states never own the same grant.
  manages_shared = var.environment == "prd"

  github_repository_name = split("/", var.github_repository)[1]
}

# --- GCP project ----------------------------------------------------------------

# Team: Owner, the only role that can apply this stack and infra/billing on a
# project without an organization (README.md "Why Owner").
# GCP refuses to grant roles/owner through the API on such a project: a new
# member is invited from the console first, then imported (import.sh).
resource "google_project_iam_member" "team" {
  #checkov:skip=CKV_GCP_117:Owner is the only role that applies this stack on a project without an organization; humans only, applied by hand, never the pipeline
  #checkov:skip=CKV_GCP_49:Same: the team creates the pipeline service accounts and their bindings in this stack
  for_each = var.team_members

  project = var.project_id
  role    = "roles/owner"
  member  = "user:${each.value}"
}

# Instructor: sees and can review every resource (subject C01 §4.3).
resource "google_project_iam_member" "instructor" {
  #checkov:skip=CKV_GCP_117:roles/editor for the instructor is required by the subject (C01 §4.3)
  #checkov:skip=CKV_GCP_49:Same: roles/editor is the role the subject asks for
  project = var.project_id
  role    = "roles/editor"
  member  = "user:${var.instructor_email}"
}

# --- Billing account (prd state only) -------------------------------------------

# Costs are only visible from the billing account, not from a project role.
# Needs a Billing Account Administrator to apply: left out while
# billing_account is null.
resource "google_billing_account_iam_member" "instructor_billing" {
  count = local.manages_shared && var.billing_account != null ? 1 : 0

  billing_account_id = var.billing_account
  role               = "roles/billing.viewer"
  member             = "user:${var.instructor_email}"
}

# --- GitHub repository (prd state only) -----------------------------------------

# A user outside the organization gets an invitation: the grant is effective
# once accepted.
resource "github_repository_collaborator" "this" {
  for_each = local.manages_shared ? var.github_collaborators : {}

  repository = local.github_repository_name
  username   = each.key
  permission = each.value
}
