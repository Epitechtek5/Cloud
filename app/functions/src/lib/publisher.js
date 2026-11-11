// Publishes validated events on their Pub/Sub topic.
//
// Topics are named after their event type (docs/pubsub.md), and each function
// only has pubsub.publisher on the topics it owns: publishing elsewhere fails
// with PERMISSION_DENIED, by design.
import { CORRELATION_ATTRIBUTE, newCorrelationId } from "./correlation.js";
import { assertEvent } from "./events.js";

async function defaultClient() {
  const { PubSub } = await import("@google-cloud/pubsub");
  return new PubSub();
}

/**
 * @param {object} options
 * @param {string} options.source  name of the publishing function (`source` attribute)
 * @param {object} [options.client]  a PubSub client (tests inject a fake one)
 * @param {Record<string, string>} [options.topics]  topic name by event type, defaults to the event type
 */
export function createPublisher({ source, client, topics = {} }) {
  if (!source) throw new Error("createPublisher needs a source");
  let clientPromise = client ? Promise.resolve(client) : undefined;
  const topicHandles = new Map();

  async function topic(name) {
    clientPromise ??= defaultClient();
    if (!topicHandles.has(name)) topicHandles.set(name, (await clientPromise).topic(name));
    return topicHandles.get(name);
  }

  return {
    /**
     * Validates then publishes an event.
     * @returns {Promise<{ messageId: string, correlationId: string }>}
     */
    async publish(eventType, payload, { correlationId = newCorrelationId(), attributes = {} } = {}) {
      assertEvent(eventType, payload);
      const handle = await topic(topics[eventType] ?? eventType);
      const messageId = await handle.publishMessage({
        json: payload,
        attributes: { ...attributes, [CORRELATION_ATTRIBUTE]: correlationId, event_type: eventType, source },
      });
      return { messageId, correlationId };
    },
  };
}
