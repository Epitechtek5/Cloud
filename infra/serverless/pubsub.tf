# Message broker of the application (issue #58): one topic per channel, its
# consumer subscription (retry backoff, dead-letter policy) and a dead-letter
# topic with a pull subscription to inspect and replay. Channels and settings
# live in modules/pubsub/catalog.tf, documented in docs/pubsub.md.
#
# The proxies and workers fill this in from their own issues:
# - publishers: `"<channel>" = [module.<fn>.service_account_email]` gives that
#   function pubsub.publisher on that topic only;
# - push: `"<channel>" = { endpoint = module.<worker>.uri, service_account = ... }`
#   delivers the subscription to its worker with an OIDC token. Until then the
#   subscription is a pull one and keeps the messages.
module "pubsub" {
  source = "./modules/pubsub"

  project_id = var.project_id

  publishers = {
    "discord.command" = module.discord_proxy[*].service_account_email
    # POST /pixels, and /draw through the same pipeline.
    "pixel.draw" = [module.draw_proxy.service_account_email, module.command_worker.service_account_email]
    # Draw worker; command worker for /admin clear (one `cleared` signal).
    "pixel.processed"    = [module.command_worker.service_account_email, module.draw_worker.service_account_email]
    "snapshot.requested" = [module.command_worker.service_account_email]
  }
  push = {
    "pixel.draw" = {
      endpoint        = module.draw_worker.uri
      service_account = google_service_account.draw_push.email
    }
    "discord.command" = {
      endpoint        = module.command_worker.uri
      service_account = google_service_account.command_push.email
    }
  }

  # The Pub/Sub service agent (DLQ IAM) only exists once the API is enabled.
  depends_on = [google_project_service.this]
}
