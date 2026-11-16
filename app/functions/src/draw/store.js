// Firestore side of the draw worker: one transaction per batch (C06 §7,
// docs/data-model.md §6). It reads the idempotency marker, the pause flag and
// the user's quota, then writes the accepted pixels, the quota, the rejected
// pixels (userEvents) and the marker atomically. Pub/Sub delivers at least
// once: a batch whose marker exists is not applied again (quota untouched).
import { firestoreTypes, toMillis } from "../lib/firestore.js";
import { COLLECTIONS, pixelId, SESSION_STATE, tileOf } from "../lib/grid.js";
import { decideBatch } from "./rules.js";
import { firestoreSpan } from "../lib/trace.js";

// Longer than the Pub/Sub retention (7 days).
export const BATCH_TTL_MS = 8 * 24 * 3600 * 1000;
// Rejections only matter to the page that is open (frontend contract §3).
export const USER_EVENT_TTL_MS = 3600 * 1000;

const toPixel = ({ x, y, color }) => ({ x, y, color });

/**
 * @param {import("@google-cloud/firestore").Firestore} db
 * @param {object} options
 * @param {number} options.defaultLimit  pixels per window without override
 * @param {number} options.windowMs
 * @param {() => number} [options.now]
 */
export function createDrawStore(db, { defaultLimit, windowMs, now = Date.now }) {
  const col = (name) => db.collection(name);

  return {
    /**
     * Applies a `pixel.draw` batch once.
     * @returns {Promise<{ duplicate: boolean, accepted: object[], rejected: object[], reason: string|null, quota: object|null }>}
     */
    async applyBatch(batch) {
      const { FieldValue, Timestamp } = await firestoreTypes();
      const uid = batch.user.id;
      return firestoreSpan("transaction draw", () => db.runTransaction(async (tx) => {
        const markerRef = col(COLLECTIONS.processedBatches).doc(batch.batchId);
        const userRef = col(COLLECTIONS.users).doc(uid);
        const [marker, session, user] = await Promise.all([tx.get(markerRef), tx.get(db.doc(SESSION_STATE)), tx.get(userRef)]);
        if (marker.exists) return { duplicate: true, ...marker.data().outcome };

        const t = now();
        const userData = user.exists ? user.data() : {};
        const decision = decideBatch({
          pixels: batch.pixels,
          paused: session.exists && session.data().paused === true,
          user: { used: userData.used, windowStart: toMillis(userData.windowStart), override: userData.override },
          now: t,
          defaultLimit,
          windowMs,
        });

        // Last write wins, ordered by the server timestamp: each pixel is its
        // own document, written whole, so it is never half from one draw and
        // half from another.
        for (const p of decision.accepted)
          tx.set(col(COLLECTIONS.pixels).doc(pixelId(p.x, p.y)), {
            x: p.x,
            y: p.y,
            tile: tileOf(p.x, p.y),
            c: p.color,
            a: uid,
            an: batch.user.name ?? uid,
            t: FieldValue.serverTimestamp(),
          });

        if (decision.quota)
          tx.set(
            userRef,
            { limit: decision.quota.limit, used: decision.quota.used, windowStart: Timestamp.fromMillis(decision.quota.windowStart) },
            { merge: true },
          );

        if (decision.rejected.length > 0)
          tx.set(col(COLLECTIONS.userEvents).doc(batch.batchId), {
            uid,
            type: "rejected",
            reason: decision.reason,
            batchId: batch.batchId,
            pixels: decision.rejected.map(toPixel),
            t: FieldValue.serverTimestamp(),
            expireAt: Timestamp.fromMillis(t + USER_EVENT_TTL_MS),
          });

        const outcome = {
          accepted: decision.accepted.map(toPixel),
          rejected: decision.rejected.map(toPixel),
          reason: decision.reason,
          quota: decision.quota,
        };
        tx.create(markerRef, { uid, outcome, at: FieldValue.serverTimestamp(), expireAt: Timestamp.fromMillis(t + BATCH_TTL_MS) });
        return { duplicate: false, ...outcome };
      }));
    },

    /** Records a batch refused before the transaction (invalid message) for its author. */
    async rejectInvalid({ batchId, uid, pixels }) {
      const { FieldValue, Timestamp } = await firestoreTypes();
      await firestoreSpan("set userEvents", () => col(COLLECTIONS.userEvents).doc(batchId).set({
        uid,
        type: "rejected",
        reason: "invalid",
        batchId,
        pixels,
        t: FieldValue.serverTimestamp(),
        expireAt: Timestamp.fromMillis(now() + USER_EVENT_TTL_MS),
      }));
    },
  };
}
