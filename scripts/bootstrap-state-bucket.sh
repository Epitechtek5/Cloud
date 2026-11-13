#!/usr/bin/env bash
# Creates the GCS bucket that holds Terraform remote state for one environment,
# then an empty state for every stack the CI plans. Both must exist BEFORE the
# first pull request plan, so they cannot be created by the stacks themselves.
# Idempotent: safe to re-run.
#
# Why the empty states: on its first `terraform init`, the gcs backend writes
# an empty <prefix>/default.tfstate. The PR plan account (gha-plan) is
# read-only on the state on purpose, so that init fails with a 403 until a
# deploy (or this script) has created it. And the release PR into main needs
# a green plan for dev and prd before anything is deployed.
#
# Usage: scripts/bootstrap-state-bucket.sh <project_id> <bucket_name> [location]
# Needs: gcloud (Owner on the project) and terraform.
# STATE_STACKS overrides the stacks (default: the `stack` matrix of
# .github/workflows/ci-terraform.yml). A new stack added to that matrix needs
# this script re-run on dev and prd before its first PR plan.
set -euo pipefail

PROJECT_ID="${1:?project id required}"
BUCKET="${2:?bucket name required}"
LOCATION="${3:-europe-west1}"
STATE_STACKS="${STATE_STACKS:-foundation serverless}"

echo ">> Enabling required APIs on ${PROJECT_ID}"
gcloud services enable storage.googleapis.com compute.googleapis.com --project "${PROJECT_ID}"

if gcloud storage buckets describe "gs://${BUCKET}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo ">> Bucket gs://${BUCKET} already exists"
else
  echo ">> Creating gs://${BUCKET} in ${LOCATION}"
  gcloud storage buckets create "gs://${BUCKET}" \
    --project "${PROJECT_ID}" \
    --location "${LOCATION}" \
    --uniform-bucket-level-access \
    --public-access-prevention
fi

# Versioning keeps previous state files: a corrupted state can be rolled back.
gcloud storage buckets update "gs://${BUCKET}" --versioning

# A backend-only configuration in a temporary directory: no provider to
# download, and the local .terraform of the stacks is left untouched. init
# never overwrites an existing state, it only creates a missing one.
backend_dir="$(mktemp -d)"
trap 'rm -rf "${backend_dir}"' EXIT
printf 'terraform {\n  backend "gcs" {}\n}\n' >"${backend_dir}/backend.tf"
for stack in ${STATE_STACKS}; do
  if gcloud storage objects describe "gs://${BUCKET}/${stack}/default.tfstate" >/dev/null 2>&1; then
    echo ">> State ${stack} already exists"
    continue
  fi
  echo ">> Creating the empty state of ${stack}"
  (
    cd "${backend_dir}"
    rm -rf .terraform .terraform.lock.hcl
    terraform init -input=false -no-color \
      -backend-config="bucket=${BUCKET}" -backend-config="prefix=${stack}" >/dev/null
  )
done
echo ">> Done"
