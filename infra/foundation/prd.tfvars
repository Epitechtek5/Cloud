project_id = "huiledecloud-cloudnative-prd"
region     = "europe-west9"
vpc_name   = "huiledecloud-prd-vpc"
cidr_block = "10.1.0.0/16"

# GKE cluster of the self-hosted CI runners. It serves the CI of both
# environments (CI_RUNNER and CI_RUNNER_TRUSTED point to its two scale sets);
# dev has none, so its destroy and re-apply cycles never take the CI down.
runners_enabled      = true
runners_zone         = "europe-west9-b"
runners_cluster_name = "huiledecloud-prd-runners"
runners_master_cidr  = "172.16.0.0/28"
