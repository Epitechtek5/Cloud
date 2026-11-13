#!/usr/bin/env bash
# One-shot adoption, into the infra/access state, of what existed before the
# stack: the resources created by the former scripts/bootstrap-wif.sh, and the
# human access granted by hand (team, instructor, GitHub collaborators).
# Idempotent: an address already in the state is skipped, and an object missing
# on GCP or GitHub is left for `terraform apply` to create.
#
# Usage (from the repository root, as a project Owner, with <env>.local.tfvars
# filled in and, for prd, GITHUB_TOKEN set: see README.md):
#   terraform -chdir=infra/access init -reconfigure -backend-config=backends/<env>.hcl
#   infra/access/import.sh <dev|prd>
set -euo pipefail

ENV_NAME="${1:?environment required (dev or prd)}"
case "${ENV_NAME}" in dev | prd) ;; *) echo "environment must be dev or prd" >&2; exit 1 ;; esac

cd "$(dirname "$0")"
VAR_FILE="${ENV_NAME}.tfvars"
LOCAL_VAR_FILE="${ENV_NAME}.local.tfvars"
if [ ! -f "${LOCAL_VAR_FILE}" ]; then
  echo "${LOCAL_VAR_FILE} missing: copy local.tfvars.example and fill it in" >&2
  exit 1
fi
TF_VARS=(-var-file="${VAR_FILE}" -var-file="${LOCAL_VAR_FILE}")

# The imports go to the backend `terraform init` configured last, whatever the
# argument: refuse unless it is the one of ENV_NAME (backends/<env>.hcl).
# Without this check, `import.sh prd` after an init on dev writes prd objects
# into the dev state, and the next dev apply removes or moves them.
hcl_value() { sed -n "s/^$1 *= *\"\([^\"]*\)\".*/\1/p" "backends/${ENV_NAME}.hcl" | tr -d '\r'; }
init_value() { sed -n "s/^ *\"$1\": *\"\([^\"]*\)\".*/\1/p" .terraform/terraform.tfstate 2>/dev/null | head -n 1 | tr -d '\r'; }
WANTED_BACKEND="$(hcl_value bucket)/$(hcl_value prefix)"
CURRENT_BACKEND="$(init_value bucket)/$(init_value prefix)"
if [ "${CURRENT_BACKEND}" != "${WANTED_BACKEND}" ]; then
  echo "Backend mismatch: initialized on '${CURRENT_BACKEND}', ${ENV_NAME} needs '${WANTED_BACKEND}'. Run first:" >&2
  echo "  terraform -chdir=infra/access init -reconfigure -backend-config=backends/${ENV_NAME}.hcl" >&2
  exit 1
fi

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

# People (humans.tf). The values come from the configuration itself (local
# tfvars and defaults), so this list follows it.
tfeval() { terraform console "${TF_VARS[@]}" <<<"$1" | tr -d '\r'; }
# Lines `  "key" = "value"` of a printed map -> key|value
map_pairs() { tfeval "$1" | sed -n 's/^ *"\([^"]*\)" = "\([^"]*\)",\{0,1\}$/\1|\2/p'; }
INSTRUCTOR="$(tfeval 'var.instructor_email' | tr -d '"')"
IMPORTS+=("google_project_iam_member.instructor|${PROJECT_ID} roles/editor user:${INSTRUCTOR}")
while IFS='|' read -r name email; do
  IMPORTS+=("google_project_iam_member.team[\"${name}\"]|${PROJECT_ID} roles/owner user:${email}")
done < <(map_pairs 'var.team_members')

# Shared by dev and prd, managed by the prd state only (humans.tf).
if [ "${ENV_NAME}" = "prd" ]; then
  BILLING_ACCOUNT="$(tfeval 'coalesce(var.billing_account, "-")' | tr -d '"')"
  if [ "${BILLING_ACCOUNT}" != "-" ]; then
    IMPORTS+=("google_billing_account_iam_member.instructor_billing[0]|${BILLING_ACCOUNT} roles/billing.viewer user:${INSTRUCTOR}")
  fi
  GITHUB_REPO_NAME="${REPO#*/}"
  while IFS='|' read -r login _; do
    IMPORTS+=("github_repository_collaborator.this[\"${login}\"]|${GITHUB_REPO_NAME}:${login}")
  done < <(map_pairs 'var.github_collaborators')
fi

in_state="$(terraform state list 2>/dev/null || true)"
for entry in "${IMPORTS[@]}"; do
  address="${entry%%|*}"
  id="${entry#*|}"
  if grep -qxF -- "${address}" <<<"${in_state}"; then
    echo ">> ${address}: already in the state"
    continue
  fi
  echo ">> ${address}"
  if ! out="$(terraform import -input=false -no-color "${TF_VARS[@]}" "${address}" "${id}" 2>&1)"; then
    if grep -qiE 'non-existent|cannot import|cannot find|not found' <<<"${out}"; then
      echo "   missing on GCP or GitHub: terraform apply will create it"
    else
      echo "${out}" >&2
      exit 1
    fi
  fi
done
# roles/editor of gha-deploy is not imported: the stack replaces it by narrower
# roles, and it is removed by hand once they are applied (README.md).
echo ">> Done. Next: terraform plan -var-file=${VAR_FILE} -var-file=${LOCAL_VAR_FILE}"
