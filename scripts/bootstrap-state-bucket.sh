#!/usr/bin/env bash
# Creates the GCS bucket that holds Terraform remote state for one environment.
# It must exist BEFORE `terraform init`, so it cannot be created by the stack
# that uses it. Idempotent: safe to re-run.
#
# Usage: scripts/bootstrap-state-bucket.sh <project_id> <bucket_name> [location]
set -euo pipefail

PROJECT_ID="${1:?project id required}"
BUCKET="${2:?bucket name required}"
LOCATION="${3:-europe-west1}"

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
echo ">> Done"
