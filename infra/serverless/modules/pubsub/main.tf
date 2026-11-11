data "google_project" "this" {
  project_id = var.project_id
}

locals {
  # The Pub/Sub service agent forwards undeliverable messages to the DLQ, so it
  # needs publisher on the DLQ topic and subscriber on the source subscription.
  service_agent = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"

  # Keyed by index (not by email) because the emails may only be known after apply.
  publisher_bindings = merge([
    for name, c in local.channels : {
      for i, sa in c.publishers : "${name}/${i}" => { channel = name, member = "serviceAccount:${sa}" }
    }
  ]...)
}

resource "google_pubsub_topic" "main" {
  #checkov:skip=CKV_GCP_83:Google-managed encryption is enough for pixel and command events (no personal data beyond Discord ids); CMEK would add a KMS key ring to manage per environment
  for_each = local.channels

  lifecycle {
    precondition {
      condition     = length(setunion(setsubtract(keys(var.publishers), keys(local.catalog)), setsubtract(keys(var.push), keys(local.catalog)))) == 0
      error_message = "publishers and push may only reference channels of the catalog (catalog.tf)."
    }
  }

  project                    = var.project_id
  name                       = each.key
  labels                     = var.labels
  message_retention_duration = each.value.message_retention_duration
}

resource "google_pubsub_topic" "dlq" {
  #checkov:skip=CKV_GCP_83:Same data as the source topic, Google-managed encryption (see google_pubsub_topic.main)
  for_each = local.channels

  project                    = var.project_id
  name                       = "${each.key}.dlq"
  labels                     = var.labels
  message_retention_duration = each.value.dlq_retention_duration
}

resource "google_pubsub_subscription" "main" {
  for_each = local.channels

  project = var.project_id
  name    = "${each.key}.sub"
  topic   = google_pubsub_topic.main[each.key].id
  labels  = var.labels

  ack_deadline_seconds       = each.value.ack_deadline_seconds
  message_retention_duration = each.value.message_retention_duration
  retain_acked_messages      = false

  retry_policy {
    minimum_backoff = each.value.minimum_backoff
    maximum_backoff = each.value.maximum_backoff
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dlq[each.key].id
    max_delivery_attempts = each.value.max_delivery_attempts
  }

  # Push only once the worker exists; otherwise a plain pull subscription.
  dynamic "push_config" {
    for_each = each.value.push == null ? [] : [each.value.push]
    content {
      push_endpoint = push_config.value.endpoint

      oidc_token {
        service_account_email = push_config.value.service_account
        audience              = coalesce(push_config.value.audience, push_config.value.endpoint)
      }
    }
  }
}

# Pull subscription on the DLQ: lets us inspect and replay failed messages.
resource "google_pubsub_subscription" "dlq" {
  for_each = local.channels

  project = var.project_id
  name    = "${each.key}.dlq.sub"
  topic   = google_pubsub_topic.dlq[each.key].id
  labels  = var.labels

  ack_deadline_seconds       = 60
  message_retention_duration = each.value.dlq_retention_duration
  retain_acked_messages      = false
}

# Publishers get publisher on their own topic, never at project level.
resource "google_pubsub_topic_iam_member" "publisher" {
  for_each = local.publisher_bindings

  project = var.project_id
  topic   = google_pubsub_topic.main[each.value.channel].name
  role    = "roles/pubsub.publisher"
  member  = each.value.member
}

resource "google_pubsub_topic_iam_member" "dlq_publisher" {
  for_each = local.channels

  project = var.project_id
  topic   = google_pubsub_topic.dlq[each.key].name
  role    = "roles/pubsub.publisher"
  member  = local.service_agent
}

resource "google_pubsub_subscription_iam_member" "source_subscriber" {
  for_each = local.channels

  project      = var.project_id
  subscription = google_pubsub_subscription.main[each.key].name
  role         = "roles/pubsub.subscriber"
  member       = local.service_agent
}
