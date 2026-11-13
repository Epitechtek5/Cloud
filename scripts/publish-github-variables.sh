#!/usr/bin/env bash
# Publishes the GitHub variables of one environment from the outputs of
# infra/access (Workload Identity provider, service accounts, state bucket).
# Nothing here is a secret. Idempotent: safe to re-run.
#
# Usage (from the repository root, after `terraform apply` of infra/access
# with backends/<env>.hcl):
#   scripts/publish-github-variables.sh <dev|prd> [owner/repo]
# Needs: terraform (read access to the access state) and gh (admin on the repo).
# Set SKIP_GH=1 to only print the variables.
set -euo pipefail

ENV_NAME="${1:?environment required (dev or prd)}"
REPO="${2:-Epitechtek5/Cloud}"
case "${ENV_NAME}" in dev | prd) ;; *) echo "environment must be dev or prd" >&2; exit 1 ;; esac

out() { terraform -chdir=infra/access output -raw "$1"; }
BUCKET="$(out state_bucket)"
if [ "${BUCKET}" != "huiledecloud-${ENV_NAME}-tfstate" ]; then
  echo "infra/access is initialised on another environment: run init -reconfigure -backend-config=backends/${ENV_NAME}.hcl" >&2
  exit 1
fi
PROVIDER="$(out workload_identity_provider)"
DEPLOY_EMAIL="$(out deploy_service_account)"
PLAN_EMAIL="$(out plan_service_account)"
SUFFIX="$(echo "${ENV_NAME}" | tr '[:lower:]' '[:upper:]')"

# Environment variables: deploy, destroy, architecture. Repository variables
# (suffixed): PR plan, which runs without an Environment.
ENV_VARS=(
  "GCP_WORKLOAD_IDENTITY_PROVIDER=${PROVIDER}"
  "GCP_SERVICE_ACCOUNT=${DEPLOY_EMAIL}"
  "TF_STATE_BUCKET=${BUCKET}"
)
REPO_VARS=(
  "GCP_WORKLOAD_IDENTITY_PROVIDER_${SUFFIX}=${PROVIDER}"
  "GCP_PLAN_SERVICE_ACCOUNT_${SUFFIX}=${PLAN_EMAIL}"
  "TF_STATE_BUCKET_${SUFFIX}=${BUCKET}"
)
echo ">> Environment ${ENV_NAME}:"
printf '   %s\n' "${ENV_VARS[@]}"
echo ">> Repository:"
printf '   %s\n' "${REPO_VARS[@]}"

if [ "${SKIP_GH:-0}" = "1" ]; then
  echo ">> SKIP_GH=1: GitHub variables not written"
  exit 0
fi

# Only create the Environment when missing: a PUT on an existing one can reset
# its protection rules (required reviewers).
gh api "repos/${REPO}/environments/${ENV_NAME}" >/dev/null 2>&1 ||
  gh api -X PUT "repos/${REPO}/environments/${ENV_NAME}" >/dev/null
for kv in "${ENV_VARS[@]}"; do
  gh variable set "${kv%%=*}" --repo "${REPO}" --env "${ENV_NAME}" --body "${kv#*=}"
done
for kv in "${REPO_VARS[@]}"; do
  gh variable set "${kv%%=*}" --repo "${REPO}" --body "${kv#*=}"
done
echo ">> Done. For prd, keep required reviewers on the Environment (Settings > Environments)."
