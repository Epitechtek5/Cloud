// Fakes of Cloud Storage and Firestore for the tile tests.
import { Buffer } from "node:buffer";

const httpError = (code) => Object.assign(new Error(`HTTP ${code}`), { code });

/** In-memory bucket with the generations and preconditions of Cloud Storage. */
export function fakeStorageBucket() {
  const objects = new Map();
  let generation = 1000;
  const calls = { save: 0, delete: 0, download: 0 };

  const bucket = {
    objects,
    calls,
    file(name, { generation: pinned } = {}) {
      return {
        name,
        async getMetadata() {
          const o = objects.get(name);
          if (!o) throw httpError(404);
          return [{ ...o.meta, name, generation: String(o.generation) }];
        },
        async download() {
          calls.download++;
          const o = objects.get(name);
          if (!o || (pinned !== undefined && pinned !== o.generation)) throw httpError(404);
          return [o.data];
        },
        async save(data, { metadata, contentType, preconditionOpts } = {}) {
          calls.save++;
          const current = objects.get(name)?.generation ?? 0;
          if (preconditionOpts?.ifGenerationMatch !== undefined && preconditionOpts.ifGenerationMatch !== current) throw httpError(412);
          objects.set(name, { data: Buffer.from(data), generation: ++generation, meta: { ...metadata, contentType } });
        },
        async delete({ ifGenerationMatch } = {}) {
          calls.delete++;
          const o = objects.get(name);
          if (!o) throw httpError(404);
          if (ifGenerationMatch !== undefined && ifGenerationMatch !== o.generation) throw httpError(412);
          objects.delete(name);
        },
      };
    },
    async *getFilesStream({ prefix = "" } = {}) {
      for (const [name, o] of [...objects]) if (name.startsWith(prefix)) yield { name, metadata: { ...o.meta, name, generation: String(o.generation) } };
    },
  };
  return bucket;
}

/** `readPixels` over an in-memory list of pixel documents `{ x, y, c, t }` (t in epoch ms). */
export function fakePixels(initial = []) {
  const docs = [...initial];
  const queries = [];
  const read = async ({ tx, ty, sinceMs, clearedAt }) => {
    queries.push({ tx, ty, sinceMs, clearedAt });
    return docs
      .filter((p) => Math.floor(p.x / 256) === tx && Math.floor(p.y / 256) === ty && p.t > sinceMs && p.t > clearedAt)
      .sort((a, b) => a.t - b.t);
  };
  return {
    docs,
    queries,
    read,
    /** Paints a pixel: the document of that pixel is replaced, as in Firestore. */
    paint(pixel) {
      const i = docs.findIndex((p) => p.x === pixel.x && p.y === pixel.y);
      if (i >= 0) docs.splice(i, 1);
      docs.push(pixel);
    },
  };
}

/**
 * Just enough of Firestore for tileState: documents by path, merge sets, and
 * transactions that run one at a time (the isolation Firestore guarantees).
 */
export function fakeStateDb() {
  const docs = new Map();
  let queue = Promise.resolve();
  return {
    docs,
    collection: (collection) => ({ doc: (id) => ({ path: `${collection}/${id}` }) }),
    runTransaction(fn) {
      const run = queue.then(async () => {
        const writes = [];
        const tx = {
          get: async (ref) => ({ exists: docs.has(ref.path), data: () => ({ ...docs.get(ref.path) }) }),
          set: (ref, data, options) => writes.push({ ref, data, options }),
        };
        const result = await fn(tx);
        for (const { ref, data, options } of writes) docs.set(ref.path, options?.merge ? { ...docs.get(ref.path), ...data } : { ...data });
        return result;
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}
