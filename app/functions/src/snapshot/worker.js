// Snapshot worker (#69): consumes snapshot.requested, renders the painted area
// of the grid to a timestamped PNG and puts it in the private snapshots bucket.
// It stops there: the bucket's object-finalized event triggers the notifier
// (event-driven, no synchronous chain). Subject 3.2, C07 §2.
import { encodePng } from "../lib/png.js";
import { createPushHandler } from "../lib/worker.js";
import { composeSnapshot, snapshotObjectName } from "./compose.js";

export const FUNCTION_NAME = "snapshot-worker";

/**
 * @param {object} deps
 * @param {() => Promise<{ pixels: object[], truncated: boolean }>} deps.readPixels
 * @param {() => Promise<{ create: Function }>} deps.getBucket
 * @param {() => number} [deps.now]
 * @param {object} [deps.logger]
 */
export function createSnapshotWorker({ readPixels, getBucket, now = Date.now, logger }) {
  return createPushHandler({
    functionName: FUNCTION_NAME,
    expect: "snapshot.requested",
    logger,
    async handle({ payload: request }, { correlationId, log }) {
      const requestLog = log.child({ userId: request.requestedBy, requestId: request.requestId });
      const requestedAt = request.requestedAt ?? now();
      const name = snapshotObjectName(requestedAt, request.requestId);

      const { pixels, truncated } = await readPixels();
      const image = composeSnapshot(pixels);
      const renderedAt = new Date(now()).toISOString();
      const png = encodePng(image.width, image.height, image.rgba, {
        text: { Title: `Pixel canvas snapshot ${new Date(requestedAt).toISOString()}`, "Creation Time": renderedAt },
      });

      // Everything the notifier needs travels with the object: it is
      // triggered by the bucket, not by this function. The interaction token
      // (15 min) stays in the private bucket, never in the logs.
      const metadata = {
        requestId: request.requestId,
        requestedBy: request.requestedBy,
        requestedAt: new Date(requestedAt).toISOString(),
        renderedAt,
        correlationId,
        reason: request.reason,
        area: `${image.x0},${image.y0},${image.side}`,
        pixels: String(pixels.length),
        truncated: String(truncated),
        ...(request.interaction ? { applicationId: request.interaction.applicationId, interactionToken: request.interaction.token } : {}),
        ...(request.channelId ? { channelId: request.channelId } : {}),
      };

      const created = await (await getBucket()).create(name, png, metadata);
      if (!created) return requestLog.info("snapshot already stored, nothing to do", { object: name });
      requestLog.info("snapshot stored", { object: name, pixels: pixels.length, truncated, bytes: png.length, factor: image.factor });
      if (truncated) requestLog.warn("snapshot truncated: too many pixels", { pixels: pixels.length });
    },
  });
}
