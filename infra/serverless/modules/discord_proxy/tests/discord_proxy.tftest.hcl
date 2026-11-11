# Plan-level checks of the Discord proxy module, with a mocked provider (no GCP needed).
mock_provider "google" {}

variables {
  project_id      = "demo-project"
  region          = "europe-west1"
  source_bucket   = "demo-sources"
  source_object   = "functions/v1.2.3.zip"
  invoker_members = ["serviceAccount:gateway@demo-project.iam.gserviceaccount.com"]
}

run "private_function_with_its_own_service_account" {
  command = plan

  assert {
    condition     = google_cloudfunctions2_function.proxy.build_config[0].entry_point == "discordProxy"
    error_message = "Wrong entry point."
  }

  assert {
    condition     = google_cloudfunctions2_function.proxy.service_config[0].timeout_seconds <= 10
    error_message = "The proxy must answer well within Discord's 3 s budget."
  }

  assert {
    condition     = google_cloudfunctions2_function.proxy.service_config[0].environment_variables["DISCORD_PUBLIC_KEY_SECRET"] == "discord-public-key"
    error_message = "The function must read the public key from Secret Manager."
  }

  assert {
    condition     = toset(keys(google_cloud_run_v2_service_iam_member.invoker)) == toset(["serviceAccount:gateway@demo-project.iam.gserviceaccount.com"])
    error_message = "Only the gateway may invoke the function."
  }

  assert {
    condition     = toset([for m in google_project_iam_member.proxy : m.role]) == toset(["roles/logging.logWriter", "roles/cloudtrace.agent"])
    error_message = "The proxy only writes logs and traces at project level."
  }

  assert {
    condition     = google_secret_manager_secret_iam_member.proxy.role == "roles/secretmanager.secretAccessor"
    error_message = "The proxy reads its secret only."
  }
}

run "refuses_public_invocation" {
  command = plan

  variables {
    invoker_members = ["allUsers"]
  }

  expect_failures = [var.invoker_members]
}

run "refuses_a_too_long_name" {
  command = plan

  variables {
    name = "a-name-that-is-way-too-long-for-a-sa"
  }

  expect_failures = [var.name]
}
