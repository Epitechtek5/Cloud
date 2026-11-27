// Snapshot notifier (#69): triggered by the snapshots bucket (object
// finalized, delivered through the snapshot.ready Pub/Sub notification with
// retry and DLQ), signs a short-lived V4 URL and posts it in Discord by
// editing the /snapshot answer (idempotent: a redelivery edits the same
// message). Subject 3.2, C07 §2.
import { createLogger } from "../lib/logger.js";
import { isValidCorrelationId, newCorrelationId } from "../lib/correlation.js";
import { DiscordApiError } from "../lib/discordWebhook.js";
import { activeTraceIds, extractContext, flushSpans, SpanKind, tracingReady, withSpan } from "../lib/trace.js";

export const FUNCTION_NAME = "snapshot-notifier";

/** The object of a Cloud Storage Pub/Sub notification (JSON_API_V1), or null if it is not a new snapshot. */
export function decodeStorageNotification(body) {
  const message = body?.message;
  if (!message || typeof message.data !== "string") return { error: "not a Pub/Sub push body" };
  const attributes = message.attributes ?? {};
  if (attributes.eventType !== "OBJECT_FINALIZE") return { skip: `event ${attributes.eventType}` };
  let object;
  try {
    object = JSON.parse(Buffer.from(message.data, "base64").toString("utf8"));
  } catch {
    return { error: "message data is not JSON" };
  }
  if (typeof object?.name !== "string" || typeof object?.bucket !== "string") return { error: "not a storage object" };
  if (!object.name.startsWith("snapshots/") || !object.name.endsWith(".png")) return { skip: "not a snapshot" };
  return { object };
}

function minutes(seconds) {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

/**
 * @param {object} deps
 * @param {{ sign: (bucket: string, name: string, ttlSeconds: number) => Promise<string> }} deps.signer
 * @param {{ editOriginal: Function }} deps.discord
 * @param {number} deps.ttlSeconds  lifetime of the signed URL
 * @param {object} [deps.logger]
 */
export function createSnapshotNotifier({ signer, discord, ttlSeconds, logger }) {
  const base = logger ?? createLogger({ function: FUNCTION_NAME });
  return async function snapshotNotifier(req, res) {
    if (req.method !== "POST") return res.status(405).set("Allow", "POST").send("method not allowed");

    const decoded = decodeStorageNotification(req.body);
    if (decoded.error) {
      base.error("rejected an invalid notification", { reason: decoded.error });
      return res.status(400).send("invalid message");
    }
    if (decoded.skip) {
      base.info("notification ignored", { reason: decoded.skip });
      return res.status(204).end();
    }

    const { object } = decoded;
    const meta = object.metadata ?? {};
    const correlationId = isValidCorrelationId(meta.correlationId) ? meta.correlationId : newCorrelationId();
    await tracingReady();
    const status = await withSpan(
      "snapshot.ready process",
      { kind: SpanKind.CONSUMER, parent: extractContext({ traceparent: meta.traceparent, tracestate: meta.tracestate }), attributes: { correlation_id: correlationId, "gcp.gcs.bucket": object.bucket } },
      () => notify(object, meta, correlationId),
    );
    await flushSpans();
    return status === 204 ? res.status(204).end() : res.status(500).send("retry");
  };

  async function notify(object, meta, correlationId) {
    const ids = activeTraceIds();
    const log = base.child({ correlationId, eventType: "snapshot.ready", userId: meta.requestedBy, requestId: meta.requestId, traceId: ids.traceId, spanId: ids.spanId, traceSampled: ids.sampled });

    if (!meta.applicationId || !meta.interactionToken) {
      log.info("snapshot without a Discord interaction, nothing to post", { object: object.name });
      return 204;
    }

    try {
      const url = await signer.sign(object.bucket, object.name, ttlSeconds);
      const interaction = { id: meta.requestId, applicationId: meta.applicationId, token: meta.interactionToken };
      await discord.editOriginal(interaction, {
        content:
          `📸 Snapshot of ${meta.requestedAt ?? object.timeCreated} (${meta.pixels ?? "?"} pixels): ${url}\nThe link expires in ${minutes(ttlSeconds)}.` +
          (meta.truncated === "true" ? "\n⚠️ The canvas is too large to capture in full: part of the drawings is missing." : ""),
      });
      log.info("snapshot link posted", { object: object.name, ttlSeconds });
      return 204;
    } catch (err) {
      if (err instanceof DiscordApiError && !err.retryable) {
        // The interaction token expired (15 min): nobody left to answer.
        log.warn("cannot answer the interaction", { status: err.status, object: object.name });
        return 204;
      }
      log.error("cannot post the snapshot link, it will be retried", { err, object: object.name });
      return 500;
    }
  }
}

/**
 * V4 signed URL (GET) of an object, signed by the function's own service
 * account through IAM signBlob: no key file. Needs
 * roles/iam.serviceAccountTokenCreator on that account only, and read access
 * to the object (the URL carries the signer's permissions).
 */
export function createStorageSigner(storage) {
  return {
    sign(bucket, name, ttlSeconds) {
      return withSpan("iam signBlob (V4 signed URL)", { kind: SpanKind.CLIENT, attributes: { "gcp.gcs.bucket": bucket } }, async () => {
        const [url] = await storage
          .bucket(bucket)
          .file(name)
          .getSignedUrl({ version: "v4", action: "read", expires: Date.now() + ttlSeconds * 1000 });
        return url;
      });
    },
  };
}
