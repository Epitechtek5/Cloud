project_id = "sage-inquiry-512409-h3" # display name: huiledecloud-cloudnative-dev
region     = "europe-west1"
env        = "dev"

# auth-discord (#67), off until its two secrets have a version: the first apply
# of this stack creates them empty, and a function cannot start on an empty
# secret. Then set the GitHub variable DISCORD_CLIENT_ID (dev application id,
# public) and pass it as TF_VAR_discord_client_id (done in #97); it is not
# written in this file. Local front only until the dev front is hosted (add its
# URL here and in the portal).
auth_discord_redirect_uris = ["http://localhost:5173/"]
