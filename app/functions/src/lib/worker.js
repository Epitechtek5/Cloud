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

/**
 * @param {object} options
 * @param {string} options.functionName
 * @param {string | string[]} options.expect  event type(s) handled
 * @param {(message: object, ctx: { correlationId: string, log: object, headers: object }) => Promise<void>} options.handle
 * @param {object} [options.logger]
 */
export function createPushHandler({ functionName, expect, handle, logger }) {
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
      return res.status(400).send("invalid message");
    }

    const { correlationId, log } = messageContext(message.attributes, { functionName, logger, headers: req.headers });
    const ctx = { correlationId, log, headers: req.headers };
    try {
      await handle(message, ctx);
      return res.status(204).end();
    } catch (err) {
      log.error("processing failed, the message will be retried", {
        err,
        messageId: message.messageId,
        deliveryAttempt: message.deliveryAttempt,
      });
      return res.status(500).send("retry");
    }
  };
}
