#!/usr/bin/env bash
# Live check of the web API through the API Gateway (#66).
#
# Without a token: POST /pixels and GET /pixels/{x}/{y} must get 401 (missing,
# garbled or forged JWT, checked by the gateway). With SESSION_TOKEN (the
# `token` of POST /auth/discord, from the browser's devtools), it also checks
# 400 on an invalid batch, 202 on a valid one, then reads the pixel back.
#
# Usage: scripts/test-pixels-api.sh <gateway_url>
#        SESSION_TOKEN=<jwt> scripts/test-pixels-api.sh <gateway_url>
set -euo pipefail

base="${1:?usage: $0 <gateway_url>}"
base="${base%/}"
fail=0

check() {
  local name="$1" expected="$2"
  shift 2
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' "$@")"
  if [ "$code" = "$expected" ]; then
    echo "ok   $name -> $code"
  else
    echo "FAIL $name -> $code (expected $expected)"
    fail=1
  fi
}

batch='{"batchId":"live-check-'"$(date +%s)"'","pixels":[{"x":99990,"y":99990,"color":16711680}]}'
forged='eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwMTIzNDU2NzgifQ.c2lnbmF0dXJl'

check "POST /pixels without token" 401 -X POST -H 'Content-Type: application/json' --data "$batch" "$base/pixels"
check "POST /pixels with a forged token" 401 -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $forged" --data "$batch" "$base/pixels"
check "GET /pixels/1/1 without token" 401 "$base/pixels/1/1"
check "GET /pixels/1/1 with garbage" 401 -H 'Authorization: Bearer garbage' "$base/pixels/1/1"

if [ -n "${SESSION_TOKEN:-}" ]; then
  auth=(-H "Authorization: Bearer $SESSION_TOKEN" -H "X-Correlation-Id: live-check-$(date +%s)")
  check "POST /pixels invalid batch" 400 -X POST -H 'Content-Type: application/json' "${auth[@]}" --data '{"batchId":"x","pixels":[{"x":100000,"y":0,"color":0}]}' "$base/pixels"
  check "POST /pixels valid batch" 202 -X POST -H 'Content-Type: application/json' "${auth[@]}" --data "$batch" "$base/pixels"
  sleep 5
  check "GET /pixels/99990/99990 after the draw" 200 "${auth[@]}" "$base/pixels/99990/99990"
else
  echo "skip authenticated checks (set SESSION_TOKEN)"
fi

exit "$fail"
