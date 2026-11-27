project_id = "sage-inquiry-512409-h3" # display name: huiledecloud-cloudnative-dev
region     = "europe-west1"
env        = "dev"

# auth-discord (#67): needs a version of discord-oauth-client-secret (added by
# hand, see README.md "Secrets"), because a function cannot start on an empty
# secret. The redirect URIs are the dev front (output app_url, derived from the
# load balancer IP, reserved by infra/access so a destroy keeps it) and the
# local front.
discord_client_id = "1562814087900037260"
auth_discord_redirect_uris = [
  "https://136-68-161-49.sslip.io/",
  "http://localhost:5173/",
]

# discord-proxy (#62), off until discord-public-key has a version (same reason).
# discord_proxy_enabled = true
