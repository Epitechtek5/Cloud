project_id   = "sage-inquiry-512409-h3" # display name: huiledecloud-cloudnative-dev
environment  = "dev"
state_bucket = "huiledecloud-dev-tfstate"

# No runner GitHub App secret containers here: the runners cluster moved to prd
# (as in infra/foundation). Applying this deletes the old dev containers.
runners_enabled = false
