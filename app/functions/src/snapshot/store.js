// I/O of the snapshot worker: every visible pixel from Firestore, and the
// private snapshots bucket.
import { readSession } from "../lib/canvas.js";
import { toMillis } from "../lib/firestore.js";
import { COLLECTIONS } from "../lib/grid.js";

/**
 * Visible pixels (painted after the last /admin clear), streamed with only the
 * fields the image needs. Two bounds, either one marks the snapshot truncated:
 * - maxReads caps the documents read, erased ones included, so a snapshot of a
 *   huge canvas ends within the function's timeout instead of being retried
 *   5 times into the DLQ. Erased pixels cannot be skipped by a query: the
 *   single-field index on `t` is disabled (hotspot, docs/data-model.md);
 * - maxPixels caps the visible pixels kept, so the instance cannot run out of
 *   memory.
 */
export async function readVisiblePixels(db, { maxPixels, maxReads }) {
  const { clearedAt } = await readSession(db);
  const pixels = [];
  let truncated = false;
  let reads = 0;
  const stream = db.collection(COLLECTIONS.pixels).select("x", "y", "c", "t").limit(maxReads).stream();
  for await (const doc of stream) {
    reads++;
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
  if (reads >= maxReads) truncated = true;
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
