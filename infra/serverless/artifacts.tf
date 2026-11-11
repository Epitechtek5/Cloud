# Function source: the zip built once by the pipeline (deploy.yml) and promoted
# unchanged from dev to prd. PR plans and destroy have no artifact, so they fall
# back to a zip built here from app/functions, with the same layout as
# `npm run build` (src/* plus package.json).
locals {
  functions_dir     = "${path.module}/../../app/functions"
  artifact_zip      = "${var.app_artifact_dir}/functions.zip"
  use_artifact      = var.app_artifact_dir != "" && fileexists(local.artifact_zip)
  functions_zip     = local.use_artifact ? local.artifact_zip : data.archive_file.functions_fallback.output_path
  functions_zip_md5 = local.use_artifact ? try(filemd5(local.artifact_zip), "") : data.archive_file.functions_fallback.output_md5
}

data "archive_file" "functions_fallback" {
  type        = "zip"
  output_path = "${path.module}/.build/functions-fallback.zip"

  dynamic "source" {
    for_each = fileset("${local.functions_dir}/src", "**")
    content {
      content  = file("${local.functions_dir}/src/${source.value}")
      filename = source.value
    }
  }

  source {
    content  = file("${local.functions_dir}/package.json")
    filename = "package.json"
  }
}

# A warning, not an error: PR plans and destroy are expected to take this path.
check "functions_artifact" {
  assert {
    condition     = local.use_artifact
    error_message = "No functions.zip in app_artifact_dir: the functions use a zip built from app/functions/src, not the pipeline artifact. Expected on PR plans and destroy only."
  }
}

resource "google_storage_bucket" "functions_source" {
  #checkov:skip=CKV_GCP_62:Access logs would need a second bucket; the objects are build inputs, already kept as the pipeline artifact
  name     = "${var.project_id}-functions-source"
  project  = var.project_id
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  # Holds only build inputs, uploaded again by the next apply.
  force_destroy = true

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 7
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.this]
}

# The md5 in the name gives every new build a new object, which is what makes
# Cloud Functions rebuild the functions that use it.
resource "google_storage_bucket_object" "functions_source" {
  name   = "functions-${local.functions_zip_md5}.zip"
  bucket = google_storage_bucket.functions_source.name
  source = local.functions_zip
}

# Images built by Cloud Build for the functions, with a cleanup policy so old
# builds do not pile up (the default gcf-artifacts repository has none).
resource "google_artifact_registry_repository" "functions" {
  #checkov:skip=CKV_GCP_84:Google-managed encryption is enough for images rebuilt from the repository at every release
  project       = var.project_id
  location      = var.region
  repository_id = "functions"
  description   = "Container images of the Cloud Run functions"
  format        = "DOCKER"

  cleanup_policy_dry_run = false

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 5
    }
  }

  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "604800s" # 7 days, never applied to the versions kept above
    }
  }

  depends_on = [google_project_service.this]
}

# Dedicated build identity: recent projects no longer give Cloud Build a usable
# default service account, and the compute default one has roles/editor.
resource "google_service_account" "functions_build" {
  project      = var.project_id
  account_id   = "fn-build"
  display_name = "Cloud Build of the functions (${var.env})"
}

# Only what a function build needs (narrower than roles/cloudbuild.builds.builder):
# write its logs, push to the functions repository, and read the sources, i.e.
# our bucket and the gcf-v2-sources-* copy Cloud Functions makes of it. The
# condition keeps the Terraform state bucket out of reach.
resource "google_project_iam_member" "functions_build_logs" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = google_service_account.functions_build.member
}

resource "google_project_iam_member" "functions_build_sources" {
  project = var.project_id
  role    = "roles/storage.objectViewer"
  member  = google_service_account.functions_build.member

  condition {
    title       = "function-sources-only"
    description = "Function source buckets only"
    expression  = "resource.name.startsWith(\"projects/_/buckets/gcf-v2-sources-\") || resource.name.startsWith(\"projects/_/buckets/${google_storage_bucket.functions_source.name}\")"
  }
}

resource "google_artifact_registry_repository_iam_member" "functions_build" {
  project    = var.project_id
  location   = google_artifact_registry_repository.functions.location
  repository = google_artifact_registry_repository.functions.name
  role       = "roles/artifactregistry.writer"
  member     = google_service_account.functions_build.member
}
