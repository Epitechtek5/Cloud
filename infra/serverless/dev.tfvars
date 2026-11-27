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

# Firebase sign-in (#145): the front opens its Firestore listeners after
# signInWithCustomToken. The Firebase project and Authentication are enabled by
# hand, once per project (README.md "Firebase sign-in"). The key is a public
# identifier (it ends up in config.json), restricted to identitytoolkit and securetoken.
auth_discord_firebase_custom_token = true
firebase_api_key                   = "AIzaSyD14dgecoCySkrf8CdW0mqLB6LdTw51Lnc"

# discord-proxy (#62), off until discord-public-key has a version (same reason).
# discord_proxy_enabled = true

# Command worker (#64): who may run /admin and /snapshot. Empty: nobody (the
# worker fails closed). Role id of the canvas admin role in the dev guild
# (Server Settings > Roles > Copy Role ID) and/or user ids.
# discord_admin_role_ids = ["<role id>"]
# discord_admin_user_ids = ["<user id>"]
