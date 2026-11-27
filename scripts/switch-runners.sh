#!/usr/bin/env bash
# Switches every workflow between our self-hosted runners and the GitHub-hosted
# ones, without touching a workflow file: it only sets the CI_RUNNER (PR jobs)
# and CI_RUNNER_TRUSTED (jobs holding credentials) repository variables.
# See docs/ci/self-hosted-runners.md ("Switching runners").
#
# Usage (from the repository root, admin on the repository):
#   scripts/switch-runners.sh <self-hosted|github-hosted> [owner/repo]
#
# The scale set names are the runners_scale_set_name and
# runners_trusted_scale_set_name outputs of infra/foundation (prd); override
# them with SCALE_SET / TRUSTED_SCALE_SET if the cluster name changes.
set -euo pipefail

MODE="${1:?mode required (self-hosted or github-hosted)}"
REPO="${2:-Epitechtek5/Cloud}"
SCALE_SET="${SCALE_SET:-huiledecloud-prd-runners}"
TRUSTED_SCALE_SET="${TRUSTED_SCALE_SET:-${SCALE_SET}-trusted}"

case "${MODE}" in
  self-hosted) runner="${SCALE_SET}" trusted="${TRUSTED_SCALE_SET}" ;;
  github-hosted) runner="ubuntu-latest" trusted="ubuntu-latest" ;;
  *) echo "mode must be self-hosted or github-hosted" >&2; exit 1 ;;
esac

gh variable set CI_RUNNER --repo "${REPO}" --body "${runner}"
gh variable set CI_RUNNER_TRUSTED --repo "${REPO}" --body "${trusted}"
echo ">> CI_RUNNER=${runner}, CI_RUNNER_TRUSTED=${trusted} on ${REPO}"
# runs-on is resolved when a job is queued: queued jobs keep the old label.
echo ">> New runs use it. Jobs already queued keep the old runner: re-run them."
