// Firestore side of the command worker. Every state change runs in a
// transaction together with the idempotency marker
// `processedCommands/{interaction id}`: a redelivered command finds the marker
// and changes nothing (Pub/Sub delivers at least once).
import { readRegion, readSession } from "../lib/canvas.js";
import { firestoreTypes } from "../lib/firestore.js";
import { COLLECTIONS, SESSION_STATE } from "../lib/grid.js";
import { firestoreSpan } from "../lib/trace.js";

// Longer than the Pub/Sub retention (7 days): a redelivery always finds it.
export const MARKER_TTL_MS = 8 * 24 * 3600 * 1000;

/**
 * @param {import("@google-cloud/firestore").Firestore} db
 * @param {object} [options]
 * @param {() => number} [options.now]
 */
export function createCommandStore(db, { now = Date.now } = {}) {
  const marker = (interactionId) => db.collection(COLLECTIONS.processedCommands).doc(interactionId);

  /** Runs `apply(tx, types)` once per interaction; returns the stored reply on a redelivery. */
  async function once(interactionId, info, apply) {
    const { FieldValue, Timestamp } = await firestoreTypes();
    return firestoreSpan("transaction command", () => db.runTransaction(async (tx) => {
      const done = await tx.get(marker(interactionId));
      if (done.exists) return { duplicate: true, reply: done.data().reply ?? null };
      const reply = await apply(tx, { FieldValue, Timestamp });
      tx.create(marker(interactionId), {
        ...info,
        reply,
        at: FieldValue.serverTimestamp(),
        expireAt: Timestamp.fromMillis(now() + MARKER_TTL_MS),
      });
      return { duplicate: false, reply };
    }));
  }

  return {
    /** Stored reply of an already processed interaction, or null. */
    async processed(interactionId) {
      const snap = await firestoreSpan("get processedCommands", () => marker(interactionId).get());
      return snap.exists ? { reply: snap.data().reply ?? null } : null;
    },

    /** Records an interaction whose effect is idempotent downstream (publish). */
    async markProcessed(interactionId, info, reply) {
      return once(interactionId, info, async () => reply);
    },

    /** /admin pause and /admin resume. */
    setPaused(interactionId, info, paused, reply) {
      return once(interactionId, info, async (tx, { FieldValue }) => {
        tx.set(db.doc(SESSION_STATE), { paused, updatedAt: FieldValue.serverTimestamp(), updatedBy: info.userId }, { merge: true });
        return reply;
      });
    },

    /**
     * /admin clear: moves the grid generation forward instead of deleting
     * 10^10 potential documents. Pixels written before `clearedAt` count as
     * erased everywhere (renderers, inspection, front).
     */
    clear(interactionId, info, reply) {
      return once(interactionId, info, async (tx, { FieldValue }) => {
        tx.set(
          db.doc(SESSION_STATE),
          {
            clearedAt: FieldValue.serverTimestamp(),
            epoch: FieldValue.increment(1),
            updatedAt: FieldValue.serverTimestamp(),
            updatedBy: info.userId,
          },
          { merge: true },
        );
        return reply;
      });
    },

    /** /admin ratelimit: per-user override, read by the draw worker. */
    setRateLimit(interactionId, info, uid, limit, reply) {
      return once(interactionId, info, async (tx, { FieldValue }) => {
        tx.set(
          db.collection(COLLECTIONS.users).doc(uid),
          { override: limit, limit, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
        return reply;
      });
    },

    readSession: () => firestoreSpan("get session", () => readSession(db)),
    readRegion: (region) => firestoreSpan("query region", () => readRegion(db, region)),
  };
}
