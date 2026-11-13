#!/usr/bin/env bash
# End-to-end check of the dead-letter policy: a message that is never acked must
# end in the DLQ after max_delivery_attempts. Needs gcloud, a deployed environment
# and a channel whose subscription is still a PULL one (no worker wired yet):
# it consumes messages of that subscription without acking them.
#
# Usage: scripts/test-pubsub-dlq.sh <project_id> [channel]   (default channel: pixel.draw)
set -euo pipefail

project="${1:?usage: $0 <project_id> [channel]}"
channel="${2:-pixel.draw}"
sub="${channel}.sub"
dlq_sub="${channel}.dlq.sub"
test_id="dlq-test-$(date +%s)-$RANDOM"

gc() { gcloud --project "$project" --quiet "$@"; }

if [ -n "$(gc pubsub subscriptions describe "$sub" --format='value(pushConfig.pushEndpoint)')" ]; then
  echo "refusing: $sub is a push subscription, a real worker consumes it" >&2
  exit 2
fi
attempts="$(gc pubsub subscriptions describe "$sub" --format='value(deadLetterPolicy.maxDeliveryAttempts)')"
echo "channel=$channel max_delivery_attempts=$attempts correlation_id=$test_id"

gc pubsub topics publish "$channel" --message='{"test":true}' \
  --attribute="correlation_id=$test_id,event_type=dlq.test,source=test-pubsub-dlq" >/dev/null

# Deliver the message without ever acking it (ack deadline 0 = immediate redelivery
# after the retry policy backoff) until Pub/Sub moves it to the DLQ.
deadline=$((SECONDS + 1500))
while [ "$SECONDS" -lt "$deadline" ]; do
  ack_id="$(gc pubsub subscriptions pull "$sub" --limit=1 --format='value(ackId)' || true)"
  if [ -n "$ack_id" ]; then
    gc pubsub subscriptions modify-message-ack-deadline "$sub" --ack-ids="$ack_id" --ack-deadline=0 >/dev/null
    echo "delivery nacked"
  fi

  found="$(gc pubsub subscriptions pull "$dlq_sub" --limit=10 --auto-ack \
    --format='value(message.attributes.correlation_id)' | grep -Fx "$test_id" || true)"
  if [ -n "$found" ]; then
    echo "OK: message $test_id reached $dlq_sub after $attempts attempts"
    exit 0
  fi
  sleep 5
done

echo "FAIL: message $test_id never reached $dlq_sub" >&2
exit 1
