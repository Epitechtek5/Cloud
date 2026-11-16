// I/O of the snapshot worker: every visible pixel from Firestore, and the
// private snapshots bucket.
import { readSession } from "../lib/canvas.js";
import { toMillis } from "../lib/firestore.js";
import { COLLECTIONS } from "../lib/grid.js";

/**
 * Visible pixels (painted after the last /admin clear), streamed with only the
 * fields the image needs. Stops at maxPixels so that a huge canvas cannot run
 * the instance out of memory; the snapshot is then marked truncated.
 */
export async function readVisiblePixels(db, { maxPixels }) {
  const { clearedAt } = await readSession(db);
  const pixels = [];
  let truncated = false;
  const stream = db.collection(COLLECTIONS.pixels).select("x", "y", "c", "t").stream();
  for await (const doc of stream) {
    const p = doc.data();
    const t = toMillis(p.t);
    if (t === null || t <= clearedAt) continue;
    if (pixels.length >= maxPixels) {
      truncated = true;
      stream.destroy();
      break;
    }
    pixels.push({ x: p.x, y: p.y, c: p.c, t });
  }
  return { pixels, truncated };
}

/** Thrown-free create-only upload: false when the object already exists. */
export function createSnapshotBucket(bucket) {
  return {
    async create(name, data, metadata) {
      try {
        await bucket.file(name).save(data, {
          resumable: false,
          contentType: "image/png",
          metadata: { cacheControl: "private, max-age=0", metadata },
          // Create only: a redelivered request finds its object and stops,
          // so the notifier is triggered once.
          preconditionOpts: { ifGenerationMatch: 0 },
        });
        return true;
      } catch (err) {
        if (err?.code === 412) return false;
        throw err;
      }
    },
  };
}
