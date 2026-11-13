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
DEPLOY_IAM_ROLE="ghaDeployIamBindings"

# Project-level roles the deploy account may grant or revoke (and nothing
# else, so it can never grant itself roles/owner). Add a role here, then
# re-run this script, before a stack binds it at project level. Never add
# roles/owner, roles/editor, roles/*Admin or roles/iam.serviceAccountTokenCreator
# (token creator at project level can impersonate every service account).
DEPLOY_GRANTABLE_ROLES=(
  roles/container.defaultNodeServiceAccount # foundation: runner nodes
  roles/logging.logWriter                   # every function, build account
  roles/monitoring.metricWriter             # functions, OpenTelemetry metrics
  roles/cloudtrace.agent                    # every function
  roles/storage.objectViewer                # build account (with a condition)
  roles/datastore.user                      # Firestore writers (workers)
  roles/datastore.viewer                    # Firestore readers
  roles/eventarc.eventReceiver              # Eventarc triggers
)

# Resource-level IAM the stacks manage (one service account per function,
# secrets, buckets, topics, Cloud Run invokers). These cannot be restricted
# by role like the project policy, but they only reach the resource itself.
DEPLOY_IAM_PERMISSIONS=(
  artifactregistry.repositories.getIamPolicy
  artifactregistry.repositories.setIamPolicy
  iam.serviceAccounts.getIamPolicy
  iam.serviceAccounts.setIamPolicy
  pubsub.subscriptions.getIamPolicy
  pubsub.subscriptions.setIamPolicy
  pubsub.topics.getIamPolicy
  pubsub.topics.setIamPolicy
  run.services.getIamPolicy
  run.services.setIamPolicy
  secretmanager.secrets.getIamPolicy
  secretmanager.secrets.setIamPolicy
  storage.buckets.getIamPolicy
  storage.buckets.setIamPolicy
)

DEPLOY_K8S_ROLE="ghaDeployK8sRbac"

# Kubernetes RBAC objects the deploy account may manage in the GKE clusters
# (the ARC Helm charts create ClusterRoles, Roles and their bindings). On GKE
# roles/editor stops short of these, and roles/container.admin would also
# bring impersonation, token creation and CSR approval: only these are added.
# bind/escalate are required to create a binding to a role with more rights
# than the caller holds through roles/editor. The two escalate permissions are
# at the TESTING support level for custom roles (gcloud warns, --quiet accepts).
DEPLOY_K8S_PERMISSIONS=(
  container.clusterRoles.bind
  container.clusterRoles.create
  container.clusterRoles.delete
  container.clusterRoles.escalate
  container.clusterRoles.update
  container.clusterRoleBindings.create
  container.clusterRoleBindings.delete
  container.clusterRoleBindings.update
  container.roles.bind
  container.roles.create
  container.roles.delete
  container.roles.escalate
  container.roles.update
  container.roleBindings.create
  container.roleBindings.delete
  container.roleBindings.update
)

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

echo ">> IAM bindings the deploy account may manage"
# roles/editor cannot set any IAM policy, and the stacks give every function
# and node pool its own least-privilege service account.
# 1. Project policy: projectIamAdmin, limited by a condition to the roles of
#    DEPLOY_GRANTABLE_ROLES (outside setIamPolicy the attribute is empty, so
#    reading the policy stays allowed).
roles_list="$(printf "'%s', " "${DEPLOY_GRANTABLE_ROLES[@]}")"
condition_file="$(mktemp)"
trap 'rm -f "${condition_file}"' EXIT
cat >"${condition_file}" <<EOF
title: grantable-roles-only
description: Deploy pipeline may only grant the roles listed in scripts/bootstrap-wif.sh
expression: "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly([${roles_list%, }])"
EOF
# Drop the previous binding first: its condition holds the old role list.
gcloud projects remove-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:${DEPLOY_EMAIL}" --role roles/resourcemanager.projectIamAdmin \
  --all >/dev/null 2>&1 || true
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:${DEPLOY_EMAIL}" --role roles/resourcemanager.projectIamAdmin \
  --condition-from-file "${condition_file}" >/dev/null

# 2. Resource policies: a custom role with only the get/setIamPolicy
#    permissions of the resource types the stacks bind.
permissions="$(IFS=,; echo "${DEPLOY_IAM_PERMISSIONS[*]}")"
role_state="$(gcloud iam roles describe "${DEPLOY_IAM_ROLE}" --project "${PROJECT_ID}" \
  --format 'value(deleted)' 2>/dev/null || echo missing)"
if [ "${role_state}" = "missing" ]; then
  gcloud iam roles create "${DEPLOY_IAM_ROLE}" --project "${PROJECT_ID}" \
    --title "GitHub deploy: resource IAM bindings" \
    --description "IAM policies of the resources managed by the Terraform stacks (scripts/bootstrap-wif.sh)" \
    --permissions "${permissions}" --stage GA >/dev/null
else
  # A deleted custom role keeps its id for 7 days: restore it instead.
  [ "${role_state}" = "True" ] &&
    gcloud iam roles undelete "${DEPLOY_IAM_ROLE}" --project "${PROJECT_ID}" >/dev/null
  gcloud iam roles update "${DEPLOY_IAM_ROLE}" --project "${PROJECT_ID}" \
    --permissions "${permissions}" --quiet >/dev/null
fi
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:${DEPLOY_EMAIL}" \
  --role "projects/${PROJECT_ID}/roles/${DEPLOY_IAM_ROLE}" --condition=None >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --project "${PROJECT_ID}" \
  --member "serviceAccount:${DEPLOY_EMAIL}" --role roles/storage.objectAdmin --condition=None >/dev/null
# --condition=None is required on re-runs: the bucket policy already holds the
# conditional plan-lock-files binding below.
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --project "${PROJECT_ID}" \
  --member "serviceAccount:${PLAN_EMAIL}" --role roles/storage.objectViewer --condition=None >/dev/null
# `terraform init` writes a .tflock object even for a plan: allow writes on
# those lock files only, never on the state itself.
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --project "${PROJECT_ID}" \
  --member "serviceAccount:${PLAN_EMAIL}" --role roles/storage.objectUser \
  --condition "title=plan-lock-files,expression=resource.name.endsWith('.tflock')" >/dev/null

echo ">> Kubernetes RBAC the deploy account may manage"
# Custom role with DEPLOY_K8S_PERMISSIONS only (see above). The PR plan
# account needs nothing more than roles/viewer: Helm records its releases in
# ConfigMaps, and it never reads the Kubernetes Secrets.
k8s_permissions="$(IFS=,; echo "${DEPLOY_K8S_PERMISSIONS[*]}")"
k8s_role_state="$(gcloud iam roles describe "${DEPLOY_K8S_ROLE}" --project "${PROJECT_ID}" \
  --format 'value(deleted)' 2>/dev/null || echo missing)"
if [ "${k8s_role_state}" = "missing" ]; then
  gcloud iam roles create "${DEPLOY_K8S_ROLE}" --project "${PROJECT_ID}" \
    --title "GitHub deploy: Kubernetes RBAC" \
    --description "Roles and bindings created by the Helm charts of the GKE clusters (scripts/bootstrap-wif.sh)" \
    --permissions "${k8s_permissions}" --stage GA --quiet >/dev/null
else
  # A deleted custom role keeps its id for 7 days: restore it instead.
  [ "${k8s_role_state}" = "True" ] &&
    gcloud iam roles undelete "${DEPLOY_K8S_ROLE}" --project "${PROJECT_ID}" >/dev/null
  gcloud iam roles update "${DEPLOY_K8S_ROLE}" --project "${PROJECT_ID}" \
    --permissions "${k8s_permissions}" --quiet >/dev/null
fi
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:${DEPLOY_EMAIL}" \
  --role "projects/${PROJECT_ID}/roles/${DEPLOY_K8S_ROLE}" --condition=None >/dev/null

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

# Only create it when missing: a PUT on an existing Environment can reset its
# protection rules (required reviewers).
gh api "repos/${REPO}/environments/${ENV_NAME}" >/dev/null 2>&1 ||
  gh api -X PUT "repos/${REPO}/environments/${ENV_NAME}" >/dev/null
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo "${REPO}" --env "${ENV_NAME}" --body "${PROVIDER_NAME}"
gh variable set GCP_SERVICE_ACCOUNT --repo "${REPO}" --env "${ENV_NAME}" --body "${DEPLOY_EMAIL}"
gh variable set TF_STATE_BUCKET --repo "${REPO}" --env "${ENV_NAME}" --body "${BUCKET}"
gh variable set "GCP_WORKLOAD_IDENTITY_PROVIDER_${SUFFIX}" --repo "${REPO}" --body "${PROVIDER_NAME}"
gh variable set "GCP_PLAN_SERVICE_ACCOUNT_${SUFFIX}" --repo "${REPO}" --body "${PLAN_EMAIL}"
gh variable set "TF_STATE_BUCKET_${SUFFIX}" --repo "${REPO}" --body "${BUCKET}"
echo ">> Done. For prd, add required reviewers on the Environment (Settings > Environments)."
