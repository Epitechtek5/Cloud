# Plan-level checks of the Pub/Sub module, with a mocked provider (no GCP needed).
# Run: terraform -chdir=infra/serverless/modules/pubsub init -backend=false && terraform -chdir=... test
mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
    }
  }
}

variables {
  project_id = "demo-project"
}

run "creates_topics_subscriptions_and_dlqs_for_every_channel" {
  command = plan

  assert {
    condition     = toset(keys(google_pubsub_topic.main)) == toset(["discord.command", "pixel.draw", "pixel.processed", "snapshot.requested"])
    error_message = "Unexpected set of topics."
  }

  assert {
    condition     = toset(keys(google_pubsub_topic.dlq)) == toset(keys(google_pubsub_topic.main))
    error_message = "Every topic needs a dead-letter topic."
  }

  assert {
    condition     = alltrue([for s in google_pubsub_subscription.main : s.dead_letter_policy[0].max_delivery_attempts >= 5])
    error_message = "Every subscription needs a dead-letter policy."
  }

  assert {
    condition     = alltrue([for s in google_pubsub_subscription.main : s.retry_policy[0].minimum_backoff == "10s" && s.retry_policy[0].maximum_backoff == "600s"])
    error_message = "Retry policy must be an exponential backoff 10s..600s."
  }

  assert {
    condition     = google_pubsub_subscription.main["snapshot.requested"].ack_deadline_seconds == 300
    error_message = "snapshot.requested needs a long ack deadline."
  }
}

run "subscriptions_are_pull_until_a_worker_is_wired" {
  command = plan

  assert {
    condition     = alltrue([for s in google_pubsub_subscription.main : length(s.push_config) == 0])
    error_message = "Without a push entry the subscription must be a pull one."
  }
}

run "push_uses_an_oidc_token" {
  command = plan

  variables {
    push = {
      "pixel.draw" = {
        endpoint        = "https://pixel-draw-abc.a.run.app"
        service_account = "push@demo-project.iam.gserviceaccount.com"
      }
    }
  }

  assert {
    condition     = google_pubsub_subscription.main["pixel.draw"].push_config[0].oidc_token[0].service_account_email == "push@demo-project.iam.gserviceaccount.com"
    error_message = "Push must be OIDC-authenticated."
  }

  assert {
    condition     = google_pubsub_subscription.main["pixel.draw"].push_config[0].oidc_token[0].audience == "https://pixel-draw-abc.a.run.app"
    error_message = "The audience defaults to the endpoint."
  }

  assert {
    condition     = length(google_pubsub_subscription.main["discord.command"].push_config) == 0
    error_message = "Other channels stay in pull mode."
  }
}

run "publishers_are_bound_on_their_own_topic_only" {
  command = plan

  variables {
    publishers = {
      "pixel.draw"      = ["draw-proxy@demo-project.iam.gserviceaccount.com"]
      "discord.command" = ["discord-proxy@demo-project.iam.gserviceaccount.com"]
    }
  }

  assert {
    condition     = length(google_pubsub_topic_iam_member.publisher) == 2
    error_message = "One publisher binding per declared publisher."
  }

  assert {
    condition     = google_pubsub_topic_iam_member.publisher["pixel.draw/0"].topic == "pixel.draw" && google_pubsub_topic_iam_member.publisher["pixel.draw/0"].member == "serviceAccount:draw-proxy@demo-project.iam.gserviceaccount.com"
    error_message = "draw-proxy must publish on pixel.draw."
  }

  assert {
    condition     = google_pubsub_topic_iam_member.publisher["discord.command/0"].member == "serviceAccount:discord-proxy@demo-project.iam.gserviceaccount.com"
    error_message = "discord-proxy must publish on discord.command."
  }

  assert {
    condition     = alltrue([for k, b in google_pubsub_topic_iam_member.publisher : startswith(k, b.topic)])
    error_message = "A publisher binding must target the topic of its channel."
  }
}

run "service_agent_can_dead_letter" {
  command = plan

  assert {
    condition     = alltrue([for b in google_pubsub_topic_iam_member.dlq_publisher : b.member == "serviceAccount:service-123456789012@gcp-sa-pubsub.iam.gserviceaccount.com" && b.role == "roles/pubsub.publisher"])
    error_message = "The Pub/Sub service agent must be publisher on every DLQ topic."
  }

  assert {
    condition     = alltrue([for b in google_pubsub_subscription_iam_member.source_subscriber : b.role == "roles/pubsub.subscriber" && b.member == "serviceAccount:service-123456789012@gcp-sa-pubsub.iam.gserviceaccount.com"])
    error_message = "The Pub/Sub service agent must be subscriber on every source subscription."
  }
}

run "rejects_unknown_channel" {
  command = plan

  variables {
    publishers = {
      "unknown.topic" = ["x@demo-project.iam.gserviceaccount.com"]
    }
  }

  expect_failures = [google_pubsub_topic.main]
}

run "rejects_non_https_push" {
  command = plan

  variables {
    push = {
      "pixel.draw" = {
        endpoint        = "http://insecure"
        service_account = "push@demo-project.iam.gserviceaccount.com"
      }
    }
  }

  expect_failures = [var.push]
}
