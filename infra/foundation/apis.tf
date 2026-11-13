# Google APIs the foundation needs that are not enabled by the bootstrap
# scripts. Cloud Resource Manager backs every project IAM binding; GKE is only
# needed where the runners cluster exists.
locals {
  project_services = toset(concat(
    ["cloudresourcemanager.googleapis.com"],
    var.runners_enabled ? ["container.googleapis.com"] : [],
  ))
}

resource "google_project_service" "foundation" {
  for_each = local.project_services

  project = var.project_id
  service = each.value

  # Other stacks and manual tooling rely on these APIs: never turn them off
  # when this resource is destroyed.
  disable_on_destroy         = false
  disable_dependent_services = false
}
