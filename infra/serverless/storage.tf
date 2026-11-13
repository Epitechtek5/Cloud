# Application buckets (subject 3.3, C06 §4.1). Never public:
# - public_access_prevention = "enforced" refuses any allUsers or
#   allAuthenticatedUsers binding, even one added by hand in the console;
# - uniform bucket-level access turns off per-object ACLs, so IAM on the bucket
#   is the only way in;
# - they are not linked to Firebase, so the browser SDK cannot reach them.
# Each function gets its own role on the bucket it needs (README, "Access to
# Firestore and the buckets"), never a project-wide storage role.
#
# No CORS on purpose: the browser never calls these buckets. Tiles reach it
# through a function (question A of docs/frontend-contract.md) and snapshots
# through a signed URL opened as a link from Discord, not fetched by a script.

locals {
  # Snapshots are timestamped images shared in Discord. prd keeps them longer
  # and refuses to destroy a bucket that still holds some.
  snapshots_retention_days = var.env == "prd" ? 90 : 7
}

# Rasters of the tiles ({tx}/{ty}.png) and the overview, rebuilt by a worker
# from Firestore. Derived data: losing them costs a regeneration, not the canvas.
resource "google_storage_bucket" "tiles" {
  #checkov:skip=CKV_GCP_62:Access logs would need a second bucket; only functions read it, and Cloud Audit Logs (Data Access) is the place to turn on if per-object access logs are needed
  #checkov:skip=CKV_GCP_78:No versioning on purpose: every regeneration overwrites the rasters, which are rebuilt from Firestore, so old versions would only be billed
  name     = "${var.project_id}-tiles"
  project  = var.project_id
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true

  # Same reason as the versioning: the default 7-day soft delete would keep
  # (and bill) every overwritten raster.
  soft_delete_policy {
    retention_duration_seconds = 0
  }

  lifecycle_rule {
    condition {
      age = 1
    }
    action {
      type = "AbortIncompleteMultipartUpload"
    }
  }

  depends_on = [google_project_service.this]
}

# Images produced by /snapshot (snapshot-worker), shared through short-lived
# signed URLs by the notifier. Their object-created event is snapshot.ready.
resource "google_storage_bucket" "snapshots" {
  #checkov:skip=CKV_GCP_62:Access logs would need a second bucket; only functions read it, and Cloud Audit Logs (Data Access) is the place to turn on if per-object access logs are needed
  name     = "${var.project_id}-snapshots"
  project  = var.project_id
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = var.env != "prd"

  # Names are timestamped, so nothing is overwritten: versioning only protects
  # against a deletion (by mistake or by a compromised function) for 7 days.
  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      age = local.snapshots_retention_days
    }
    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 7
    }
    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    condition {
      age = 1
    }
    action {
      type = "AbortIncompleteMultipartUpload"
    }
  }

  depends_on = [google_project_service.this]
}

output "tiles_bucket" {
  value       = google_storage_bucket.tiles.name
  description = "Private bucket of the tile rasters"
}

output "snapshots_bucket" {
  value       = google_storage_bucket.snapshots.name
  description = "Private bucket of the /snapshot images"
}
