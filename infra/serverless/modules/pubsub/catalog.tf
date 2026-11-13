# The channels of the platform (subject 3.1, C06 §3.3, C07 §1.2) and their
# retention / retry settings. `snapshot.ready` is not here: it is the GCS
# object event of the snapshot bucket, not a Pub/Sub topic we publish on.
# Values are documented in docs/pubsub.md.
locals {
  catalog = {
    # Admin/Discord commands forwarded by the Discord proxy: short handlers.
    "discord.command" = {
      ack_deadline_seconds  = 60
      max_delivery_attempts = 5
    }
    # Pixel batches written to Firestore by the draw worker.
    "pixel.draw" = {
      ack_deadline_seconds  = 30
      max_delivery_attempts = 5
    }
    # Processed pixels fanned out to the real-time channel.
    "pixel.processed" = {
      ack_deadline_seconds  = 30
      max_delivery_attempts = 5
    }
    # Snapshot rendering and upload to GCS: slower, fewer retries.
    "snapshot.requested" = {
      ack_deadline_seconds  = 300
      max_delivery_attempts = 5
    }
  }

  channels = {
    for name, c in local.catalog : name => {
      message_retention_duration = "604800s"  # 7 days: time to process, replay, debug
      dlq_retention_duration     = "1209600s" # 14 days: time to investigate
      publishers                 = lookup(var.publishers, name, [])
      ack_deadline_seconds       = c.ack_deadline_seconds
      max_delivery_attempts      = c.max_delivery_attempts
      minimum_backoff            = "10s"
      maximum_backoff            = "600s"
      push                       = lookup(var.push, name, null)
    }
  }
}
