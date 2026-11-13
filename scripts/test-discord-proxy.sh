#!/usr/bin/env bash
# Live check of the Discord interactions proxy through the API Gateway: a request
# without a signature or with a wrong one must get 401. (A valid signed request
# needs Discord's private key: the PING validation of the developer portal is the
# live positive test, see docs/discord-bot.md.)
#
# Usage: scripts/test-discord-proxy.sh <gateway_url_of_the_route>
set -euo pipefail

url="${1:?usage: $0 <gateway_url_of_the_route>}"
body='{"type":1}'
fail=0

check() {
  local name="$1" expected="$2"
  shift 2
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' "$@" --data "$body" "$url")"
  if [ "$code" = "$expected" ]; then
    echo "ok   $name -> $code"
  else
    echo "FAIL $name -> $code (expected $expected)"
    fail=1
  fi
}

check "no signature" 401
check "bad signature" 401 \
  -H "X-Signature-Ed25519: $(printf '0%.0s' {1..128})" \
  -H "X-Signature-Timestamp: $(date +%s)"
check "malformed signature" 401 \
  -H "X-Signature-Ed25519: not-hex" \
  -H "X-Signature-Timestamp: $(date +%s)"

exit "$fail"
