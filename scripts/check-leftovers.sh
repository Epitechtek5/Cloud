#!/usr/bin/env bash
# Lists what is left in a project after destroy.yml (issue #56, subject 2.2):
# every resource kind the workload stacks (infra/foundation, infra/serverless)
# create, plus what GCP creates on their behalf (Cloud Functions source
# buckets, GKE disks and load balancers, NAT IPs). Read-only.
#
# Expected after a destroy, and not reported: the state bucket (*-tfstate) and
# what infra/access keeps on purpose (persistent.tf: the "frontend" global
# address and the Discord and runner GitHub App secret containers). IAM, APIs and the default VPC
# are free and are not listed.
#
# Uses one `gcloud ... list` per kind rather than Cloud Asset Inventory, whose
# API is not enabled on the projects. A kind whose API is disabled has nothing.
#
# Usage: scripts/check-leftovers.sh <project_id>
#   AR_LOCATIONS overrides the Artifact Registry locations to look at.
# Exit code: 0 when nothing unexpected is left, 1 otherwise, 2 on a gcloud error.
set -uo pipefail

PROJECT="${1:?project id required}"
KEEP_ADDRESSES='^frontend$'
KEEP_BUCKETS='-tfstate$'
KEEP_SECRETS='^(discord-public-key|discord-bot-token|discord-oauth-client-secret|arc-github-app-id|arc-github-app-installation-id|arc-github-app-private-key)$'

leftovers=0
errors=0

# check <label> <keep regex or ""> <gcloud args...>: one line per resource name.
check() {
  local label="$1" keep="$2"
  shift 2
  local out
  if ! out="$(gcloud "$@" --project "${PROJECT}" --quiet 2>&1)"; then
    if grep -qiE 'has not been used|is disabled|SERVICE_DISABLED' <<<"${out}"; then
      printf '%-34s none (API disabled)\n' "${label}"
      return
    fi
    printf '%-34s ERROR\n%s\n' "${label}" "${out}" >&2
    errors=$((errors + 1))
    return
  fi
  local names
  names="$(grep -v '^Listed 0 items' <<<"${out}" | grep -v '^Listing items' | sed '/^$/d')"
  if [ -n "${keep}" ]; then
    names="$(grep -vE -- "${keep}" <<<"${names}")"
  fi
  if [ -z "${names}" ]; then
    printf '%-34s none\n' "${label}"
    return
  fi
  printf '%-34s LEFT:\n' "${label}"
  sed 's/^/    /' <<<"${names}"
  leftovers=$((leftovers + $(wc -l <<<"${names}")))
}

echo "Leftovers in ${PROJECT}:"
check "Compute instances" "" compute instances list --format='value(name)'
check "Compute disks" "" compute disks list --format='value(name)'
check "Compute snapshots" "" compute snapshots list --format='value(name)'
check "Compute images" "" compute images list --no-standard-images --format='value(name)'
check "IP addresses" "${KEEP_ADDRESSES}" compute addresses list --format='value(name)'
check "Forwarding rules" "" compute forwarding-rules list --format='value(name)'
check "Backend services" "" compute backend-services list --format='value(name)'
check "Backend buckets" "" compute backend-buckets list --format='value(name)'
check "URL maps" "" compute url-maps list --format='value(name)'
check "SSL certificates" "" compute ssl-certificates list --format='value(name)'
check "Routers (Cloud NAT)" "" compute routers list --format='value(name)'
check "VPC networks" '^default$' compute networks list --format='value(name)'
check "GKE clusters" "" container clusters list --format='value(name)'
check "Buckets" "${KEEP_BUCKETS}" storage buckets list --format='value(name)'
# Artifact Registry has no "all locations" listing: the regions of dev and prd.
for location in ${AR_LOCATIONS:-europe-west1 europe-west9 europe}; do
  check "Artifact Registry (${location})" "" artifacts repositories list --location="${location}" --format='value(name)'
done
check "Cloud Functions" "" functions list --format='value(name)'
check "Cloud Run services" "" run services list --format='value(metadata.name)'
check "API Gateway gateways" "" api-gateway gateways list --format='value(name)'
check "API Gateway APIs" "" api-gateway apis list --format='value(name)'
check "Pub/Sub topics" "" pubsub topics list --format='value(name)'
check "Pub/Sub subscriptions" "" pubsub subscriptions list --format='value(name)'
check "Eventarc triggers" "" eventarc triggers list --location=- --format='value(name)'
check "Firestore databases" "" firestore databases list --format='value(name)'
check "Secrets" "${KEEP_SECRETS}" secrets list --format='value(name)'

echo
if [ "${errors}" -gt 0 ]; then
  echo "${errors} kind(s) could not be listed: the check is incomplete." >&2
  exit 2
fi
if [ "${leftovers}" -gt 0 ]; then
  echo "${leftovers} unexpected resource(s) left."
  exit 1
fi
echo "Nothing left but the state bucket and the access stack."
