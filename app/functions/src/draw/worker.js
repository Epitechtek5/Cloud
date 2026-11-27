// Draw worker (#65): the only writer of the grid. Consumes `pixel.draw` from
// the web proxy (brush batches) and from /draw (command worker), applies the
// pause and the per-user rate limit in a Firestore transaction, then emits
// `pixel.processed` and, for /draw, edits the Discord answer. Subject 3.3,
// C07 §1.2, docs/frontend-contract.md §1 and §3.
import { DiscordApiError } from "../lib/discordWebhook.js";
import { createPushHandler } from "../lib/worker.js";
import { drawReply } from "./rules.js";

export const FUNCTION_NAME = "draw-worker";

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SNOWFLAKE = /^\d{5,25}$/;

/**
 * Who sent a batch that failed validation, so that the front can drop its
 * optimistic pixels (`userEvents` reason `invalid`). Null when the message
 * does not even say who sent it: it then goes to the DLQ.
 */
export function identifyInvalid(body) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body?.message?.data ?? "", "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (body?.message?.attributes?.event_type !== "pixel.draw") return null;
  const batchId = payload?.batchId;
  const uid = payload?.user?.id;
  if (typeof batchId !== "string" || !ID.test(batchId) || typeof uid !== "string" || !SNOWFLAKE.test(uid)) return null;
  const pixels = (Array.isArray(payload.pixels) ? payload.pixels : [])
    .slice(0, 256)
    .filter((p) => [p?.x, p?.y, p?.color].every(Number.isFinite))
    .map(({ x, y, color }) => ({ x, y, color }));
  return { batchId, uid, pixels };
}

/**
 * @param {object} deps
 * @param {() => Promise<object>} deps.getStore  draw store (store.js), built lazily
 * @param {{ publish: Function }} deps.publisher  allowed on pixel.processed only
 * @param {{ editOriginal: Function }} deps.discord  interaction client (answers /draw)
 * @param {object} [deps.logger]
 */
export function createDrawWorker({ getStore, publisher, discord, logger }) {
  return createPushHandler({
    functionName: FUNCTION_NAME,
    expect: "pixel.draw",
    logger,

    async onInvalid(body, err, { log }) {
      const who = identifyInvalid(body);
      if (!who) return false;
      await (await getStore()).rejectInvalid(who);
      log.warn("batch rejected as invalid", { batchId: who.batchId, userId: who.uid });
      return true;
    },

    async handle({ payload: batch }, { correlationId, log }) {
      const batchLog = log.child({ userId: batch.user.id, batchId: batch.batchId, source: batch.source });
      const outcome = await (await getStore()).applyBatch(batch);

      if (outcome.duplicate) batchLog.info("batch already applied, outcome replayed");
      else
        batchLog.info("batch applied", {
          accepted: outcome.accepted.length,
          rejected: outcome.rejected.length,
          reason: outcome.reason,
          used: outcome.quota?.used,
          limit: outcome.quota?.limit,
        });

      // Replayed on a redelivery too: if the previous delivery committed then
      // failed before publishing, nothing is lost. Consumers dedupe on
      // (userId, batchId): a batch id is only unique per user.
      await publisher.publish(
        "pixel.processed",
        {
          batchId: batch.batchId,
          userId: batch.user.id,
          pixels: outcome.accepted,
          rejected: outcome.rejected.map(({ x, y }) => ({ x, y, reason: outcome.reason })),
        },
        { correlationId },
      );

      if (!batch.interaction) return;
      try {
        await discord.editOriginal(batch.interaction, drawReply(outcome, batch.pixels[0]));
      } catch (err) {
        if (!(err instanceof DiscordApiError) || err.retryable) throw err;
        batchLog.warn("cannot answer the interaction", { status: err.status });
      }
    },
  });
}
