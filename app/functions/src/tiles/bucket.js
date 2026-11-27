// The private `tiles` bucket: one PNG per tile, `tiles/{tx}/{ty}.png`, served
// to the browser by the front's load balancer and CDN (backend bucket, tiles.tf).
//
// Writes are compare-and-set on the object generation: two renderers of the
// same tile (a lease that expired under a slow one) cannot overwrite each
// other's work, the loser gets a TileConflictError and starts over from what
// the winner wrote.
import { emptyRaster, decodeRaster, encodeRaster, TILE_PREFIX, tileName, VERSION_METADATA } from "./raster.js";
import { PngError } from "../lib/pngDecode.js";

export class TileConflictError extends Error {
  constructor(tx, ty) {
    super(`tile ${tx}/${ty} was changed by someone else`);
    this.name = "TileConflictError";
    this.retryable = true;
  }
}

const notFound = (err) => err?.code === 404;
const preconditionFailed = (err) => err?.code === 412;

/** Runs `fn` on every item, `limit` at a time. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * @param {import("@google-cloud/storage").Bucket} bucket
 * @param {object} [options]
 * @param {number} [options.cacheMaxAgeSeconds]  Cache-Control of the rasters, followed by the CDN
 */
export function createTileBucket(bucket, { cacheMaxAgeSeconds = 60 } = {}) {
  const cacheControl = `public, max-age=${cacheMaxAgeSeconds}`;
  return {
    /**
     * Raster of a tile, or null when the tile was never rendered (or erased).
     * A raster that cannot be decoded reads as a blank one with version 0: the
     * caller rebuilds it from Firestore and overwrites it.
     * @returns {Promise<{ rgba: Uint8Array, version: number, generation: number } | null>}
     */
    async read(tx, ty) {
      const name = tileName(tx, ty);
      let meta;
      try {
        [meta] = await bucket.file(name).getMetadata();
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
      const generation = Number(meta.generation);
      let data;
      try {
        // Pinned to the generation just read: the bytes and the generation match.
        [data] = await bucket.file(name, { generation }).download();
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
      try {
        return { ...decodeRaster(data), generation };
      } catch (err) {
        if (!(err instanceof PngError)) throw err;
        return { rgba: emptyRaster(), version: 0, generation };
      }
    },

    /** Writes the raster; `generation` is the one read (undefined: the tile must not exist yet). */
    async write(tx, ty, rgba, version, { generation } = {}) {
      try {
        await bucket.file(tileName(tx, ty)).save(encodeRaster(rgba, version), {
          resumable: false,
          contentType: "image/png",
          metadata: { cacheControl, metadata: { [VERSION_METADATA]: String(version) } },
          preconditionOpts: { ifGenerationMatch: generation ?? 0 },
        });
      } catch (err) {
        if (preconditionFailed(err)) throw new TileConflictError(tx, ty);
        throw err;
      }
    },

    /** Deletes the raster of a tile (nothing left to show). A concurrent rewrite wins. */
    async remove(tx, ty, { generation }) {
      try {
        await bucket.file(tileName(tx, ty)).delete({ ifGenerationMatch: generation });
      } catch (err) {
        if (!notFound(err) && !preconditionFailed(err)) throw err;
      }
    },

    /**
     * After /admin clear: deletes every raster whose version is not newer than
     * the clear, i.e. rendered before it. A raster rendered after the clear has
     * a newer version and stays; one rewritten while we list is kept too
     * (delete is conditional on the listed generation).
     *
     * The listing covers the whole bucket (up to 152 881 tiles for the whole
     * grid), so it deletes as it goes, holding a few names at a time, and stops
     * at `deadline` (`complete: false`): the caller retries, and what was
     * deleted is not listed again as stale. The rasters not erased yet are
     * ignored meanwhile (the renderer and the front drop a raster whose version
     * is not newer than the clear).
     * @returns {Promise<{ erased: number, complete: boolean }>}
     */
    async deleteStale(clearedAt, { concurrency = 16, deadline = Infinity, now = Date.now } = {}) {
      let erased = 0;
      let pending = [];
      const flush = async () => {
        const batch = pending;
        pending = [];
        await mapLimit(batch, concurrency, async ({ name, generation }) => {
          try {
            await bucket.file(name).delete({ ifGenerationMatch: generation });
          } catch (err) {
            if (!notFound(err) && !preconditionFailed(err)) throw err;
          }
        });
        erased += batch.length;
      };

      let complete = true;
      for await (const file of bucket.getFilesStream({ prefix: TILE_PREFIX })) {
        if (now() > deadline) {
          complete = false;
          break;
        }
        const version = Number(file.metadata?.metadata?.[VERSION_METADATA]);
        // No readable version: not one of ours, or written by an older renderer; erase it, it is rebuilt on the next draw.
        if (!Number.isFinite(version) || version <= clearedAt) pending.push({ name: file.name, generation: Number(file.metadata.generation) });
        if (pending.length >= concurrency * 8) await flush();
      }
      await flush();
      return { erased, complete };
    },
  };
}
