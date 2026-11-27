// HTTP plumbing shared by the Pub/Sub push workers.
//
// Pub/Sub acks a pushed message on any 2xx. Anything else (or a timeout) makes
// it retry with backoff, then move the message to the channel's dead-letter
// topic after max_delivery_attempts (docs/pubsub.md):
// - 204: done, or nothing to do (duplicate);
// - 400: the message itself is broken (not a push body, wrong type, invalid
//   payload): retrying cannot fix it, it ends in the DLQ for inspection;
// - 500: our side failed (Firestore, Discord, Pub/Sub): retried.
import { messageContext } from "./context.js";
import { EventValidationError } from "./events.js";
import { decodePushMessage, InvalidPushError } from "./pubsubPush.js";
import { extractContext, flushSpans, SpanKind, tracingReady, withSpan } from "./trace.js";

/**
 * @param {object} options
 * @param {string} options.functionName
 * @param {string | string[]} options.expect  event type(s) handled
 * @param {(message: object, ctx: { correlationId: string, log: object, headers: object }) => Promise<void>} options.handle
 * @param {(body: object, err: Error, ctx: { log: object }) => Promise<boolean>} [options.onInvalid]
 *   called for a broken message; returning true acks it (204) instead of 400
 * @param {object} [options.logger]
 */
export function createPushHandler({ functionName, expect, handle, onInvalid, logger }) {
  return async function pushHandler(req, res) {
    if (req.method !== "POST") return res.status(405).set("Allow", "POST").send("method not allowed");

    let message;
    try {
      message = decodePushMessage(req.body, { expect });
    } catch (err) {
      if (!(err instanceof InvalidPushError || err instanceof EventValidationError)) throw err;
      const { log } = messageContext(req.body?.message?.attributes, { functionName, logger, headers: req.headers });
      // err.message names the invalid paths only, never the values.
      log.error("rejected an invalid message", { reason: err.message, messageId: req.body?.message?.messageId });
      try {
        if (onInvalid && (await onInvalid(req.body, err, { log }))) return res.status(204).end();
      } catch (hookErr) {
        log.error("cannot record the invalid message, it will be retried", { err: hookErr });
        return res.status(500).send("retry");
      }
      return res.status(400).send("invalid message");
    }

    await tracingReady();
    // Child of the publisher's span (traceparent attribute): one trace from
    // the proxy to this worker and everything it calls.
    const status = await withSpan(
      `${message.eventType} process`,
      {
        kind: SpanKind.CONSUMER,
        parent: extractContext(message.attributes),
        attributes: {
          "messaging.system": "gcp_pubsub",
          "messaging.message.id": message.messageId,
          "messaging.gcp_pubsub.message.delivery_attempt": message.deliveryAttempt ?? 1,
          correlation_id: message.correlationId,
        },
      },
      async (span) => {
        const { correlationId, log } = messageContext(message.attributes, { functionName, logger, headers: req.headers });
        try {
          await handle(message, { correlationId, log, headers: req.headers });
          return 204;
        } catch (err) {
          span.recordException(err);
          span.setStatus({ code: 2, message: err?.name });
          log.error("processing failed, the message will be retried", {
            err,
            messageId: message.messageId,
            deliveryAttempt: message.deliveryAttempt,
          });
          return 500;
        }
      },
    );
    await flushSpans();
    return status === 204 ? res.status(204).end() : res.status(500).send("retry");
  };
}
