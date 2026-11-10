project_id = "huiledecloud-cloudnative-prd"
region     = "europe-west9"
vpc_name   = "huiledecloud-prd-vpc"
cidr_block = "10.1.0.0/16"

# No runners cluster here: CI_RUNNER targets the single dev scale set (runners_enabled = false).
