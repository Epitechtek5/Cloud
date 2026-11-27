// Coalescing of the renders of one tile, in Firestore (`tileState/{tx}_{ty}`).
//
// A brush burst sends hundreds of `pixel.processed` messages for the same
// tile, handled by several instances at once. Instead of one render per
// message, each tile has at most one *leader* at a time:
//
//   touch    every message adds 1 to `seq` (the "dirty" counter). The message
//            that finds no live lease becomes the leader; the others have
//            nothing more to do, the leader will render their pixels too.
//   checkpoint  the leader rendered everything up to the `seq` it read before
//            rendering. If `seq` has not moved, it releases the tile; if it
//            has, more messages came in meanwhile and it renders again.
//
// The lease (`leaseUntil`) only exists so that a leader that died cannot hold a
// tile forever: its own message is redelivered by Pub/Sub after the ack
// deadline, finds the lease expired and takes over. Everything is a
// transaction on one small document, so two instances never both lead.
import { firestoreTypes } from "../lib/firestore.js";

export const TILE_STATE_COLLECTION = "tileState";

/**
 * @param {import("@google-cloud/firestore").Firestore} db
 * @param {object} [options]
 * @param {number} [options.leaseMs]  how long a leader owns a tile without checking in
 * @param {() => number} [options.now]
 */
export function createTileState(db, { leaseMs = 25_000, now = Date.now } = {}) {
  const ref = (tile) => db.collection(TILE_STATE_COLLECTION).doc(tile);

  return {
    /**
     * Records that the tile changed and claims it when nobody leads it.
     * @returns {Promise<{ leader: boolean, seq: number }>}  `seq`: the counter this render must cover
     */
    async touch(tile, owner) {
      const { FieldValue } = await firestoreTypes();
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref(tile));
        const data = snap.exists ? snap.data() : {};
        const seq = (data.seq ?? 0) + 1;
        const taken = (data.leaseUntil ?? 0) > now() && data.owner !== owner;
        if (taken) {
          tx.set(ref(tile), { seq }, { merge: true });
          return { leader: false, seq };
        }
        tx.set(ref(tile), { seq, owner, leaseUntil: now() + leaseMs, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return { leader: true, seq };
      });
    },

    /**
     * The leader rendered everything up to `rendered`.
     * - done: nothing arrived since, the tile is released;
     * - otherwise `seq` is the new target, the lease is renewed;
     * - lost: the lease expired and someone else took the tile, stop.
     * @returns {Promise<{ done: boolean, lost?: boolean, seq?: number }>}
     */
    async checkpoint(tile, owner, rendered) {
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref(tile));
        const data = snap.exists ? snap.data() : {};
        if (data.owner !== owner) return { done: false, lost: true };
        if ((data.seq ?? 0) === rendered) {
          tx.set(ref(tile), { owner: null, leaseUntil: 0, renderedSeq: rendered }, { merge: true });
          return { done: true };
        }
        tx.set(ref(tile), { leaseUntil: now() + leaseMs }, { merge: true });
        return { done: false, seq: data.seq };
      });
    },

    /** Gives the tile back after a failure, so that the retry (or the next message) can lead it right away. */
    async release(tile, owner) {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref(tile));
        if (snap.exists && snap.data().owner === owner) tx.set(ref(tile), { owner: null, leaseUntil: 0 }, { merge: true });
      });
    },
  };
}
