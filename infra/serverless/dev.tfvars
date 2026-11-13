project_id = "sage-inquiry-512409-h3" # display name: huiledecloud-cloudnative-dev
region     = "europe-west1"
env        = "dev"

# auth-discord (#67), off until its two secrets have a version: the first apply
# of this stack creates them empty, and a function cannot start on an empty
# secret. Then uncomment (dev application id, public) in a follow-up PR. Local
# front only until the dev front is hosted (add its URL here and in the portal).
# discord_client_id          = "1562814087900037260"
auth_discord_redirect_uris = ["http://localhost:5173/"]
