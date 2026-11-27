project_id = "sage-inquiry-512409-h3" # display name: huiledecloud-cloudnative-dev
region     = "europe-west1"
vpc_name   = "huiledecloud-dev-vpc"
cidr_block = "10.0.0.0/16"

# No runners cluster here: it lives in prd (runners_enabled = true in
# prd.tfvars), so destroying and re-creating dev never takes the CI down.
runners_enabled = false
