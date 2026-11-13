#!/usr/bin/env bash
# Checks, as an anonymous internet client, that the application data of one
# environment is closed: the tiles and snapshots buckets cannot be listed or
# read, and Firestore refuses an unauthenticated write. Uses curl only, with no
# credentials, so it sees exactly what a stranger sees. Read-only: the write
# attempt is refused before anything is stored.
#
# Usage: scripts/check-private-access.sh <project_id>
set -euo pipefail

PROJECT_ID="${1:?project id required (the id, not the display name)}"
failed=0

# expect <description> <allowed codes, space separated> <curl args...>
expect() {
  local what="$1" allowed="$2"
  shift 2
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "$@")"
  if [[ " ${allowed} " == *" ${code} "* ]]; then
    echo "OK    ${what}: HTTP ${code}"
  else
    echo "FAIL  ${what}: HTTP ${code} (expected ${allowed})"
    failed=1
  fi
}

for bucket in "${PROJECT_ID}-tiles" "${PROJECT_ID}-snapshots"; do
  # 401: anonymous caller refused. 404 would mean a wrong project id.
  expect "list gs://${bucket}" "401 403" "https://storage.googleapis.com/storage/v1/b/${bucket}/o"
  expect "read gs://${bucket}/0/0.png" "401 403" "https://storage.googleapis.com/${bucket}/0/0.png"
done

# Same request as a browser without a Firebase token. Only the message of the
# security rules counts: a missing project or database also answers 403, with
# another message.
body="$(curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"fields":{"c":{"integerValue":"0"}}}' \
  "https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/pixels/0_0")"
if [[ "${body}" == *"Missing or insufficient permissions"* ]]; then
  echo "OK    anonymous Firestore write: refused by the security rules"
else
  echo "FAIL  anonymous Firestore write: not a security rules refusal:"
  echo "${body}" | head -5
  failed=1
fi

exit "${failed}"
