// I/O of the snapshot worker: every visible pixel from Firestore, and the
// private snapshots bucket.
import { readSession } from "../lib/canvas.js";
import { toMillis } from "../lib/firestore.js";
import { COLLECTIONS } from "../lib/grid.js";
import { firestoreSpan, SpanKind, withSpan } from "../lib/trace.js";

/**
 * Visible pixels (painted after the last /admin clear), streamed with only the
 * fields the image needs. Three bounds, any one marks the snapshot truncated:
 * - budgetMs caps the reading time, so the snapshot is encoded and uploaded
 *   within the function's timeout whatever the Firestore throughput, instead
 *   of being retried 5 times into the DLQ;
 * - maxReads caps the documents read, erased ones included (the whole
 *   collection is scanned: the single-field index on `t` is disabled, hotspot,
 *   docs/data-model.md);
 * - maxPixels caps the visible pixels kept, so the instance cannot run out of
 *   memory.
 */
export function readVisiblePixels(db, options) {
  return firestoreSpan("stream pixels", async (span) => {
    const out = await readAll(db, options);
    span.setAttribute("pixels", out.pixels.length);
    return out;
  });
}

async function readAll(db, { maxPixels, maxReads, budgetMs, now = Date.now }) {
  const deadline = now() + budgetMs;
  const { clearedAt } = await readSession(db);
  const pixels = [];
  let truncated = false;
  let reads = 0;
  // One extra document tells a collection of exactly maxReads documents
  // (complete) from a larger one (truncated).
  const stream = db.collection(COLLECTIONS.pixels).select("x", "y", "c", "t").limit(maxReads + 1).stream();
  for await (const doc of stream) {
    if (++reads > maxReads || now() >= deadline) {
      truncated = true;
      stream.destroy();
      break;
    }
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
    create(name, data, metadata) {
      return withSpan("gcs upload snapshot", { kind: SpanKind.CLIENT, attributes: { "gcp.gcs.bucket": bucket.name, bytes: data.length } }, () => upload(name, data, metadata));
    },
  };

  async function upload(name, data, metadata) {
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
  }
}
