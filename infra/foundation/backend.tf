# Backend blocks cannot use variables: the bucket/prefix come from
# backends/<env>.hcl, passed with `terraform init -backend-config=...`.
terraform {
  backend "gcs" {}
}
