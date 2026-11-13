# Firestore (native mode): the structured state of the canvas (pixels, rate
# limits, pause flag). The model and the reasons behind it are in
# docs/data-model.md.
#
# Two kinds of callers, two kinds of checks:
# - the workers use the server SDK with their own service account: IAM decides
#   (roles/datastore.user), the security rules do not apply to them;
# - the browser uses the Firebase SDK with a custom token: only the security
#   rules (firestore.rules) apply, and they deny every write.

locals {
  # prd survives a mistaken replace or destroy (delete protection) and can be
  # restored to any minute of the last 7 days (PITR); dev stays disposable.
  firestore_protected = var.env == "prd"
}

# Kept next to its only user rather than in apis.tf. Same rule as there: never
# disabled on destroy.
resource "google_project_service" "firebaserules" {
  project                    = var.project_id
  service                    = "firebaserules.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false
}

# The "(default)" database: the one the browser SDK opens without extra
# configuration, and the one covered by the free tier.
resource "google_firestore_database" "main" {
  project     = var.project_id
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  # Transactions (rate limit, idempotency) take locks instead of retrying.
  concurrency_mode            = "PESSIMISTIC"
  app_engine_integration_mode = "DISABLED"

  point_in_time_recovery_enablement = local.firestore_protected ? "POINT_IN_TIME_RECOVERY_ENABLED" : "POINT_IN_TIME_RECOVERY_DISABLED"
  delete_protection_state           = local.firestore_protected ? "DELETE_PROTECTION_ENABLED" : "DELETE_PROTECTION_DISABLED"
  # DELETE so that destroy.yml really removes the dev database (the default,
  # ABANDON, would leave it behind and break the next apply). On prd, the
  # delete protection above still refuses it.
  deletion_policy = "DELETE"

  depends_on = [google_project_service.this]
}

# --- Indexes -----------------------------------------------------------------

# Front listener of one visible tile, newer than its raster:
#   pixels.where("tile", "==", "tx_ty").where("t", ">", version).orderBy("t")
# An equality on one field plus a range on another needs a composite index.
resource "google_firestore_index" "pixels_by_tile" {
  project    = var.project_id
  database   = google_firestore_database.main.name
  collection = "pixels"

  fields {
    field_path = "tile"
    order      = "ASCENDING"
  }

  fields {
    field_path = "t"
    order      = "ASCENDING"
  }

  # Firestore always appends __name__ with the direction of the last field;
  # declaring it avoids a permanent diff.
  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }
}

# Front listener of the user's rejected pixels:
#   userEvents.where("uid", "==", me).where("t", ">", pageOpenedAt)
resource "google_firestore_index" "user_events_by_uid" {
  project    = var.project_id
  database   = google_firestore_database.main.name
  collection = "userEvents"

  fields {
    field_path = "uid"
    order      = "ASCENDING"
  }

  fields {
    field_path = "t"
    order      = "ASCENDING"
  }

  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }
}

# --- Single-field overrides ----------------------------------------------------

# pixels.t is a server timestamp, so it only grows. Firestore indexes every
# field on its own by default, and an index on an always-increasing value sends
# every write to the same place: about 500 writes/s for the whole collection.
# No query uses t on its own (the composite index above starts with tile), so
# its single-field index is switched off.
resource "google_firestore_field" "pixels_t" {
  project    = var.project_id
  database   = google_firestore_database.main.name
  collection = "pixels"
  field      = "t"

  index_config {}
}

# TTL policies: Firestore deletes a document once its expireAt is in the past
# (usually within 24 h; each deletion is billed as a normal delete). The worker
# sets expireAt when it writes the document. Not indexed: never queried, and it
# only grows too.
resource "google_firestore_field" "ttl" {
  for_each = toset([
    "userEvents",       # rejected pixels shown to their author, ~1 h
    "processedBatches", # idempotency keys, longer than the Pub/Sub retention (7 days)
  ])

  project    = var.project_id
  database   = google_firestore_database.main.name
  collection = each.value
  field      = "expireAt"

  ttl_config {}
  index_config {}
}

# --- Security rules (browser SDK only) ---------------------------------------

# A ruleset is immutable: editing firestore.rules creates a new one, and the
# release (also replaced) points "cloud.firestore", i.e. the (default)
# database, to it. create_before_destroy keeps the gap without a release as
# short as possible; without a release every browser request is denied.
resource "google_firebaserules_ruleset" "firestore" {
  project = var.project_id

  source {
    files {
      name    = "firestore.rules"
      content = file("${path.module}/firestore.rules")
    }
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [
    google_project_service.firebaserules,
    google_firestore_database.main,
  ]
}

resource "google_firebaserules_release" "firestore" {
  project      = var.project_id
  name         = "cloud.firestore"
  ruleset_name = "projects/${var.project_id}/rulesets/${google_firebaserules_ruleset.firestore.name}"
}

output "firestore_database" {
  value       = google_firestore_database.main.name
  description = "Firestore database id, to pass to the functions"
}
