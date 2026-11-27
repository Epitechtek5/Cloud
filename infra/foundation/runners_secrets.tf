# GitHub App credentials of the runners (issue #54), sourced from Secret
# Manager instead of a Kubernetes Secret created by hand.
#
#   Secret Manager (infra/access, persistent.tf: survives a destroy)
#     --(secretAccessor on these 3 secrets only)--> Google SA arc-secrets
#     <--(workloadIdentityUser, one KSA only)-- KSA arc-runners/arc-secrets-reader
#     <--(TokenRequest)-- External Secrets controller (scoped to arc-runners)
#     --> Kubernetes Secret arc-github-app, read by the ARC scale set
#
# No service account key: the controller asks Kubernetes for a token of the
# reader KSA and exchanges it through GKE Workload Identity. No pod runs as
# that KSA. The values never go through Terraform: the data sources below only
# read the secret metadata, so nothing lands in the state or in the outputs.
#
# Order: secrets IAM + Workload Identity + External Secrets -> SecretStore and
# ExternalSecret -> scale set (runners.tf). On destroy the scale set goes
# first, while the Secret still exists: the controller needs it to remove the
# scale set registration from GitHub.

locals {
  eso_namespace = "external-secrets"
  eso_chart_dir = "${local.runners_values}/github-app-secret"
  # KSA impersonating the Google SA; only External Secrets uses it.
  secrets_reader_ksa = "arc-secrets-reader"

  # Key of the Kubernetes Secret expected by ARC => Secret Manager secret id
  # (created in infra/access, values added out of band).
  arc_github_secret_keys = {
    github_app_id              = "arc-github-app-id"
    github_app_installation_id = "arc-github-app-installation-id"
    github_app_private_key     = "arc-github-app-private-key"
  }
  arc_github_secret_ids = var.runners_enabled ? toset(values(local.arc_github_secret_keys)) : toset([])
}

# Fails the plan if infra/access was not applied first: the containers live
# there so that a destroy of this stack keeps their values.
data "google_secret_manager_secret" "arc_github_app" {
  for_each = local.arc_github_secret_ids

  project   = var.project_id
  secret_id = each.value
}

resource "google_service_account" "runners_secrets" {
  count = var.runners_enabled ? 1 : 0

  # Fixed id: there is one runners cluster per project, and the cluster name
  # plus a suffix would exceed the 30 characters of a service account id.
  account_id   = "arc-secrets"
  display_name = "Reads the runners GitHub App secrets (External Secrets, ${var.runners_cluster_name})"
}

# Those three secrets only, no project-wide role.
resource "google_secret_manager_secret_iam_member" "runners_secrets" {
  for_each = data.google_secret_manager_secret.arc_github_app

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runners_secrets[0].email}"
}

# Only the reader KSA of the runners namespace may act as the Google SA. The
# workload pool comes from the cluster: IAM refuses the member until it exists.
resource "google_service_account_iam_member" "runners_secrets_workload_identity" {
  count = var.runners_enabled ? 1 : 0

  service_account_id = google_service_account.runners_secrets[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${google_container_cluster.runners[0].workload_identity_config[0].workload_pool}[${local.runners_namespace}/${local.secrets_reader_ksa}]"
}

resource "kubernetes_service_account_v1" "secrets_reader" {
  count = var.runners_enabled ? 1 : 0

  metadata {
    name      = local.secrets_reader_ksa
    namespace = kubernetes_namespace_v1.runners[local.runners_namespace].metadata[0].name
    annotations = {
      "iam.gke.io/gcp-service-account" = google_service_account.runners_secrets[0].email
    }
  }

  # No pod mounts it: External Secrets requests short-lived tokens for it.
  automount_service_account_token = false
}

# External Secrets Operator, restricted to the runners namespace: namespaced
# RBAC only (no ClusterSecretStore, no PushSecret), no webhook. Its own pod
# has no Google identity (its KSA is not bound to any Google SA).
resource "helm_release" "external_secrets" {
  count = var.runners_enabled ? 1 : 0

  name       = "external-secrets"
  namespace  = kubernetes_namespace_v1.runners[local.eso_namespace].metadata[0].name
  repository = "https://charts.external-secrets.io"
  chart      = "external-secrets"
  version    = var.runners_eso_version

  values = [
    file("${local.runners_values}/external-secrets-values.yaml"),
    yamlencode({
      scopedNamespace = local.runners_namespace
    }),
  ]

  wait    = true
  timeout = 600
}

# SecretStore + ExternalSecret, from a local chart: kubernetes_manifest would
# need the External Secrets CRDs at plan time, which do not exist on the first
# apply after a destroy.
resource "helm_release" "arc_github_secret" {
  count = var.runners_enabled ? 1 : 0

  name      = "arc-github-app"
  namespace = kubernetes_namespace_v1.runners[local.runners_namespace].metadata[0].name
  chart     = local.eso_chart_dir

  values = [
    yamlencode({
      secretName = local.arc_github_secret
      keys       = local.arc_github_secret_keys
      store = {
        projectID      = var.project_id
        serviceAccount = kubernetes_service_account_v1.secrets_reader[0].metadata[0].name
        cluster = {
          name     = google_container_cluster.runners[0].name
          location = google_container_cluster.runners[0].location
        }
      }
    }),
  ]

  # The first sync needs the operator (CRDs, controller) and the whole access
  # chain; on destroy, this release goes before them.
  depends_on = [
    helm_release.external_secrets,
    google_secret_manager_secret_iam_member.runners_secrets,
    google_service_account_iam_member.runners_secrets_workload_identity,
  ]
}
