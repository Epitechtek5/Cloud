project_id = "sage-inquiry-512409-h3" # display name: huiledecloud-cloudnative-dev
region     = "europe-west1"
vpc_name   = "huiledecloud-dev-vpc"
cidr_block = "10.0.0.0/16"

# GKE cluster of the self-hosted CI runners
runners_cluster_name = "huiledecloud-dev-runners"
runners_master_cidr  = "172.16.0.0/28"
