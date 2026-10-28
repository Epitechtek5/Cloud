#!/usr/bin/env bash
# Installs (or upgrades) Actions Runner Controller and the runner scale set on
# the runners GKE cluster. Run it from a machine allowed by
# runners_authorized_networks.
#
# Usage: ENV=dev GITHUB_APP_ID=... GITHUB_APP_INSTALLATION_ID=... \
#        GITHUB_APP_PRIVATE_KEY_FILE=app.pem ./install.sh
set -euo pipefail

ENV="${ENV:?ENV must be dev or prd}"
: "${GITHUB_APP_ID:?}" "${GITHUB_APP_INSTALLATION_ID:?}" "${GITHUB_APP_PRIVATE_KEY_FILE:?}"

# Pin the chart version: an upgrade must be a deliberate change.
ARC_VERSION="${ARC_VERSION:-0.10.1}"
RUNNERS_NS=arc-runners
CONTROLLER_NS=arc-systems
SCALE_SET_NAME="${SCALE_SET_NAME:-huiledecloud-$ENV-runners}"
CLUSTER="${CLUSTER:-huiledecloud-$ENV-runners}"
REGION="${REGION:?REGION must be set (europe-west1 for dev, europe-west9 for prd)}"
DIR="$(cd "$(dirname "$0")" && pwd)"

gcloud container clusters get-credentials "$CLUSTER" --region "$REGION"

# Namespaces and network policy are plain manifests (kustomization.yaml).
kubectl apply -k "$DIR"

helm upgrade --install arc \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller \
  --version "$ARC_VERSION" --namespace "$CONTROLLER_NS" \
  --values "$DIR/controller-values.yaml"

kubectl --namespace "$RUNNERS_NS" create secret generic arc-github-app \
  --from-literal=github_app_id="$GITHUB_APP_ID" \
  --from-literal=github_app_installation_id="$GITHUB_APP_INSTALLATION_ID" \
  --from-file=github_app_private_key="$GITHUB_APP_PRIVATE_KEY_FILE" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install "$SCALE_SET_NAME" \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set \
  --version "$ARC_VERSION" --namespace "$RUNNERS_NS" \
  --values "$DIR/runner-set-values.yaml"

echo "Runners ready: set the CI_RUNNER repository variable to '$SCALE_SET_NAME'."
