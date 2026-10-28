project_id = "huiledecloud-cloudnative-prd"
region     = "europe-west9"
vpc_name   = "huiledecloud-prd-vpc"
cidr_block = "10.1.0.0/16"

# GKE cluster of the self-hosted CI runners
runners_cluster_name = "huiledecloud-prd-runners"
runners_master_cidr  = "172.16.0.16/28"
