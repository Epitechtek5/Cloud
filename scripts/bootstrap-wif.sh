#!/usr/bin/env bash
# Sets up keyless GitHub Actions -> GCP authentication (Workload Identity
# Federation) for one environment, then publishes the matching GitHub
# variables. Nothing here is a secret: no service account key is created.
# Idempotent: safe to re-run.
#
# Usage: scripts/bootstrap-wif.sh <project_id> <dev|prd> [owner/repo]
# Needs: gcloud (Owner on the project) and gh (admin on the repo).
# Set SKIP_GH=1 to only print the variables instead of writing them.
set -euo pipefail

PROJECT_ID="${1:?project id required (the id, not the display name)}"
ENV_NAME="${2:?environment required (dev or prd)}"
REPO="${3:-Epitechtek5/Cloud}"
BUCKET="huiledecloud-${ENV_NAME}-tfstate"
POOL="github"
PROVIDER="github"
DEPLOY_SA="gha-deploy"
PLAN_SA="gha-plan"

case "${ENV_NAME}" in dev | prd) ;; *) echo "environment must be dev or prd" >&2; exit 1 ;; esac

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
POOL_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}"
PROVIDER_NAME="${POOL_NAME}/providers/${PROVIDER}"
DEPLOY_EMAIL="${DEPLOY_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
PLAN_EMAIL="${PLAN_SA}@${PROJECT_ID}.iam.gserviceaccount.com"

echo ">> Enabling required APIs on ${PROJECT_ID}"
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  --project "${PROJECT_ID}"

echo ">> Workload Identity pool and GitHub OIDC provider"
gcloud iam workload-identity-pools describe "${POOL}" --location global --project "${PROJECT_ID}" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create "${POOL}" --location global \
    --display-name "GitHub Actions" --project "${PROJECT_ID}"

# The condition restricts the whole pool to this repository.
gcloud iam workload-identity-pools providers describe "${PROVIDER}" \
  --workload-identity-pool "${POOL}" --location global --project "${PROJECT_ID}" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc "${PROVIDER}" \
    --workload-identity-pool "${POOL}" --location global --project "${PROJECT_ID}" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition "assertion.repository=='${REPO}'"

echo ">> Service accounts"
for sa in "${DEPLOY_SA}" "${PLAN_SA}"; do
  gcloud iam service-accounts describe "${sa}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --project "${PROJECT_ID}" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "${sa}" --project "${PROJECT_ID}"
done

echo ">> Who may impersonate them"
# Deploy: only jobs running in the matching GitHub Environment (prd has reviewers).
gcloud iam service-accounts add-iam-policy-binding "${DEPLOY_EMAIL}" --project "${PROJECT_ID}" \
  --role roles/iam.workloadIdentityUser \
  --member "principal://iam.googleapis.com/${POOL_NAME}/subject/repo:${REPO}:environment:${ENV_NAME}" >/dev/null
# Plan: any workflow of the repository (read-only, used on pull requests).
gcloud iam service-accounts add-iam-policy-binding "${PLAN_EMAIL}" --project "${PROJECT_ID}" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/${POOL_NAME}/attribute.repository/${REPO}" >/dev/null

echo ">> What they may do"
# roles/editor is broad: narrow it once the deployed resources are known.
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:${DEPLOY_EMAIL}" --role roles/editor --condition=None >/dev/null
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:${PLAN_EMAIL}" --role roles/viewer --condition=None >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --project "${PROJECT_ID}" \
  --member "serviceAccount:${DEPLOY_EMAIL}" --role roles/storage.objectAdmin >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --project "${PROJECT_ID}" \
  --member "serviceAccount:${PLAN_EMAIL}" --role roles/storage.objectViewer >/dev/null

SUFFIX="$(echo "${ENV_NAME}" | tr '[:lower:]' '[:upper:]')"
echo ">> GitHub variables for ${ENV_NAME}"
echo "   Environment ${ENV_NAME} (deploy, destroy, architecture):"
echo "     GCP_WORKLOAD_IDENTITY_PROVIDER=${PROVIDER_NAME}"
echo "     GCP_SERVICE_ACCOUNT=${DEPLOY_EMAIL}"
echo "     TF_STATE_BUCKET=${BUCKET}"
echo "   Repository (PR plan, no Environment):"
echo "     GCP_WORKLOAD_IDENTITY_PROVIDER_${SUFFIX}=${PROVIDER_NAME}"
echo "     GCP_PLAN_SERVICE_ACCOUNT_${SUFFIX}=${PLAN_EMAIL}"
echo "     TF_STATE_BUCKET_${SUFFIX}=${BUCKET}"

if [ "${SKIP_GH:-0}" = "1" ]; then
  echo ">> SKIP_GH=1: GitHub variables not written"
  exit 0
fi

gh api -X PUT "repos/${REPO}/environments/${ENV_NAME}" >/dev/null
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo "${REPO}" --env "${ENV_NAME}" --body "${PROVIDER_NAME}"
gh variable set GCP_SERVICE_ACCOUNT --repo "${REPO}" --env "${ENV_NAME}" --body "${DEPLOY_EMAIL}"
gh variable set TF_STATE_BUCKET --repo "${REPO}" --env "${ENV_NAME}" --body "${BUCKET}"
gh variable set "GCP_WORKLOAD_IDENTITY_PROVIDER_${SUFFIX}" --repo "${REPO}" --body "${PROVIDER_NAME}"
gh variable set "GCP_PLAN_SERVICE_ACCOUNT_${SUFFIX}" --repo "${REPO}" --body "${PLAN_EMAIL}"
gh variable set "TF_STATE_BUCKET_${SUFFIX}" --repo "${REPO}" --body "${BUCKET}"
echo ">> Done. For prd, add required reviewers on the Environment (Settings > Environments)."
