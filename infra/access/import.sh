#!/usr/bin/env bash
# One-shot adoption of the resources created by the former
# scripts/bootstrap-wif.sh into the infra/access state. Idempotent: an address
# already in the state is skipped, and an object missing on GCP is left for
# `terraform apply` to create.
#
# Usage (from the repository root, as a project Owner):
#   terraform -chdir=infra/access init -reconfigure -backend-config=backends/<env>.hcl
#   infra/access/import.sh <dev|prd>
set -euo pipefail

ENV_NAME="${1:?environment required (dev or prd)}"
case "${ENV_NAME}" in dev | prd) ;; *) echo "environment must be dev or prd" >&2; exit 1 ;; esac

cd "$(dirname "$0")"
VAR_FILE="${ENV_NAME}.tfvars"
tfvar() { sed -n "s/^$1 *= *\"\([^\"]*\)\".*/\1/p" "${VAR_FILE}"; }
PROJECT_ID="$(tfvar project_id)"
BUCKET="$(tfvar state_bucket)"
REPO="Epitechtek5/Cloud"
REPO_IDS="Epitechtek5@345497600/Cloud@1429506566"
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
POOL="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github"
DEPLOY="gha-deploy@${PROJECT_ID}.iam.gserviceaccount.com"
PLAN="gha-plan@${PROJECT_ID}.iam.gserviceaccount.com"

# address|import id
IMPORTS=(
  "google_project_service.this[\"cloudresourcemanager.googleapis.com\"]|${PROJECT_ID}/cloudresourcemanager.googleapis.com"
  "google_project_service.this[\"iam.googleapis.com\"]|${PROJECT_ID}/iam.googleapis.com"
  "google_project_service.this[\"iamcredentials.googleapis.com\"]|${PROJECT_ID}/iamcredentials.googleapis.com"
  "google_project_service.this[\"sts.googleapis.com\"]|${PROJECT_ID}/sts.googleapis.com"
  # By project id, not number: imported by number, `project` differs from the
  # configuration and Terraform plans to replace the pool (a deleted pool id
  # stays reserved for 30 days).
  "google_iam_workload_identity_pool.github|projects/${PROJECT_ID}/locations/global/workloadIdentityPools/github"
  "google_iam_workload_identity_pool_provider.github|projects/${PROJECT_ID}/locations/global/workloadIdentityPools/github/providers/github"
  "google_service_account.deploy|projects/${PROJECT_ID}/serviceAccounts/${DEPLOY}"
  "google_service_account.plan|projects/${PROJECT_ID}/serviceAccounts/${PLAN}"
  "google_service_account_iam_member.deploy_wif[\"repo:${REPO}:environment:${ENV_NAME}\"]|projects/${PROJECT_ID}/serviceAccounts/${DEPLOY} roles/iam.workloadIdentityUser principal://iam.googleapis.com/${POOL}/subject/repo:${REPO}:environment:${ENV_NAME}"
  "google_service_account_iam_member.deploy_wif[\"repo:${REPO_IDS}:environment:${ENV_NAME}\"]|projects/${PROJECT_ID}/serviceAccounts/${DEPLOY} roles/iam.workloadIdentityUser principal://iam.googleapis.com/${POOL}/subject/repo:${REPO_IDS}:environment:${ENV_NAME}"
  "google_service_account_iam_member.plan_wif|projects/${PROJECT_ID}/serviceAccounts/${PLAN} roles/iam.workloadIdentityUser principalSet://iam.googleapis.com/${POOL}/attribute.repository/${REPO}"
  "google_project_iam_member.deploy_grantable|${PROJECT_ID} roles/resourcemanager.projectIamAdmin serviceAccount:${DEPLOY} grantable-roles-only"
  "google_project_iam_custom_role.deploy_iam_bindings|projects/${PROJECT_ID}/roles/ghaDeployIamBindings"
  "google_project_iam_member.deploy_iam_bindings|${PROJECT_ID} projects/${PROJECT_ID}/roles/ghaDeployIamBindings serviceAccount:${DEPLOY}"
  "google_project_iam_custom_role.deploy_k8s_rbac|projects/${PROJECT_ID}/roles/ghaDeployK8sRbac"
  "google_project_iam_member.deploy_k8s_rbac|${PROJECT_ID} projects/${PROJECT_ID}/roles/ghaDeployK8sRbac serviceAccount:${DEPLOY}"
  "google_storage_bucket_iam_member.deploy_state|b/${BUCKET} roles/storage.objectAdmin serviceAccount:${DEPLOY}"
  "google_project_iam_member.plan[\"roles/viewer\"]|${PROJECT_ID} roles/viewer serviceAccount:${PLAN}"
  "google_project_iam_member.plan[\"roles/iam.securityReviewer\"]|${PROJECT_ID} roles/iam.securityReviewer serviceAccount:${PLAN}"
  "google_project_iam_member.plan[\"roles/firebaserules.viewer\"]|${PROJECT_ID} roles/firebaserules.viewer serviceAccount:${PLAN}"
  "google_storage_bucket_iam_member.plan_state|b/${BUCKET} roles/storage.objectViewer serviceAccount:${PLAN}"
  "google_storage_bucket_iam_member.plan_state_locks|b/${BUCKET} roles/storage.objectUser serviceAccount:${PLAN} plan-lock-files"
)

in_state="$(terraform state list 2>/dev/null || true)"
for entry in "${IMPORTS[@]}"; do
  address="${entry%%|*}"
  id="${entry#*|}"
  if grep -qxF -- "${address}" <<<"${in_state}"; then
    echo ">> ${address}: already in the state"
    continue
  fi
  echo ">> ${address}"
  if ! out="$(terraform import -input=false -no-color -var-file="${VAR_FILE}" "${address}" "${id}" 2>&1)"; then
    if grep -qiE 'non-existent|cannot import|cannot find|not found' <<<"${out}"; then
      echo "   missing on GCP: terraform apply will create it"
    else
      echo "${out}" >&2
      exit 1
    fi
  fi
done
# roles/editor of gha-deploy is not imported: the stack replaces it by narrower
# roles, and it is removed by hand once they are applied (README.md).
echo ">> Done. Next: terraform plan -var-file=${VAR_FILE}"
