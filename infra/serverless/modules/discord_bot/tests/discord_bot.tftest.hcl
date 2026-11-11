# Plan-level checks of the Discord bot token module, with a mocked provider (no GCP needed).
mock_provider "google" {}

variables {
  project_id        = "demo-project"
  registrar_members = ["serviceAccount:deploy@demo-project.iam.gserviceaccount.com"]
}

run "only_the_deploy_identity_reads_the_token" {
  command = plan

  assert {
    condition     = google_secret_manager_secret.bot_token.secret_id == "discord-bot-token"
    error_message = "Unexpected secret id (deploy-env.yml reads discord-bot-token)."
  }

  assert {
    condition     = toset(keys(google_secret_manager_secret_iam_member.registrar)) == toset(["serviceAccount:deploy@demo-project.iam.gserviceaccount.com"])
    error_message = "Only the deploy service account may read the token."
  }
}

run "refuses_users_and_public_members" {
  command = plan

  variables {
    registrar_members = ["allUsers"]
  }

  expect_failures = [var.registrar_members]
}
