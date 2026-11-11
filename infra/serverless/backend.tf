# Backend blocks cannot use variables: the bucket/prefix come from
# backends/<env>.hcl locally, and from -backend-config in the pipeline.
terraform {
  backend "gcs" {}
}
