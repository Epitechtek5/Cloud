#!/usr/bin/env bash
# Demo of a forced failure (#73): publishes a broken message on a channel whose
# worker is deployed. The worker answers 400 to every delivery, Pub/Sub retries
# with backoff, then moves the message to <channel>.dlq after
# max_delivery_attempts (5): the "DLQ" rows of the application dashboard show
# it a few minutes later. The message carries no user, so nothing is written.
#
# Usage: scripts/demo-dlq-failure.sh <project_id> [channel]   (default: pixel.draw)
# Clean up afterwards: gcloud pubsub subscriptions pull <channel>.dlq.sub --auto-ack --limit 10
set -euo pipefail

project="${1:?usage: $0 <project_id> [channel]}"
channel="${2:-pixel.draw}"
id="dlq-demo-$(date +%s)"

gc() { gcloud --project "$project" --quiet "$@"; }

gc pubsub topics publish "$channel" --message='{"broken":true}' \
  --attribute="event_type=$channel,correlation_id=$id,source=demo-dlq-failure"
echo "published a broken message on $channel (correlation_id=$id)"
echo "worker logs:  jsonPayload.correlation_id=\"$id\"   (one ERROR per delivery attempt)"
echo "waiting for it in $channel.dlq.sub (up to 10 min)..."

for _ in $(seq 1 60); do
  sleep 10
  found="$(gc pubsub subscriptions pull "$channel.dlq.sub" --limit 10 --format=json \
    | jq -r --arg id "$id" '.[] | select(.message.attributes.correlation_id == $id) | .ackId')"
  if [ -n "$found" ]; then
    echo "ok   the message reached $channel.dlq (left there, visible in the DLQ widget)"
    exit 0
  fi
done
echo "FAIL the message did not reach $channel.dlq within 10 minutes" >&2
exit 1
