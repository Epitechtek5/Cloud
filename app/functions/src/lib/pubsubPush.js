// Decodes the body of a Pub/Sub push request (worker side).
//
// Push subscriptions POST `{ message: { data, attributes, messageId }, subscription }`
// with `data` in base64. The worker re-emits the correlation id it receives.
import { correlationFromAttributes } from "./correlation.js";
import { assertEvent } from "./events.js";

export class InvalidPushError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidPushError";
  }
}

/**
 * @param {object} body  the push request body
 * @param {object} [options]
 * @param {string | string[]} [options.expect]  event type(s) this worker handles; any other type is refused
 * @returns {{ eventType: string, payload: object, correlationId: string, messageId: string, attributes: object, deliveryAttempt?: number }}
 * @throws {InvalidPushError | import("./events.js").EventValidationError}
 */
export function decodePushMessage(body, { expect } = {}) {
  const message = body?.message;
  if (!message || typeof message.data !== "string") throw new InvalidPushError("not a Pub/Sub push body");
  const attributes = message.attributes ?? {};
  const eventType = attributes.event_type;
  if (!eventType) throw new InvalidPushError("missing event_type attribute");
  if (expect !== undefined && ![expect].flat().includes(eventType))
    throw new InvalidPushError(`unexpected event_type ${eventType}`);

  let payload;
  try {
    payload = JSON.parse(Buffer.from(message.data, "base64").toString("utf8"));
  } catch {
    throw new InvalidPushError("message data is not JSON");
  }
  assertEvent(eventType, payload);

  return {
    eventType,
    payload,
    correlationId: correlationFromAttributes(attributes),
    messageId: message.messageId ?? message.message_id,
    attributes,
    deliveryAttempt: body.deliveryAttempt,
  };
}
