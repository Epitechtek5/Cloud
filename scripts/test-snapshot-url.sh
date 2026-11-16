#!/usr/bin/env bash
# Live check of a /snapshot link (#69): the signed URL posted in Discord serves
# the PNG, the same object without the signature is refused, and the link
# expires after its lifetime (X-Goog-Expires).
#
# Usage: scripts/test-snapshot-url.sh '<signed url>' [--wait]
#   --wait  sleeps until the expiry and checks the link is then refused
set -euo pipefail

url="${1:?usage: $0 '<signed url>' [--wait]}"
fail=0

code_of() { curl -sS -o /dev/null -w '%{http_code}' "$1"; }

signed="$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "$url")"
if [[ "$signed" == "200 image/png"* ]]; then echo "ok   signed URL -> $signed"; else echo "FAIL signed URL -> $signed (expected 200 image/png)"; fail=1; fi

unsigned="$(code_of "${url%%\?*}")"
if [[ "$unsigned" == 401 || "$unsigned" == 403 ]]; then echo "ok   same object without signature -> $unsigned"; else echo "FAIL unsigned -> $unsigned (expected 401/403)"; fail=1; fi

expires="$(sed -n 's/.*[?&]X-Goog-Expires=\([0-9]*\).*/\1/p' <<<"$url")"
date_param="$(sed -n 's/.*[?&]X-Goog-Date=\([0-9TZ]*\).*/\1/p' <<<"$url")"
echo "info signed at $date_param, valid ${expires}s"

if [ "${2:-}" = "--wait" ]; then
  signed_at="$(date -u -d "$(sed -E 's/(....)(..)(..)T(..)(..)(..)Z/\1-\2-\3 \4:\5:\6/' <<<"$date_param")" +%s)"
  left=$((signed_at + expires - $(date +%s) + 5))
  if [ "$left" -gt 0 ]; then echo "info waiting ${left}s for the expiry"; sleep "$left"; fi
  after="$(code_of "$url")"
  if [ "$after" = 400 ] || [ "$after" = 403 ]; then echo "ok   expired link -> $after"; else echo "FAIL expired link -> $after (expected 400/403)"; fail=1; fi
fi

exit "$fail"
