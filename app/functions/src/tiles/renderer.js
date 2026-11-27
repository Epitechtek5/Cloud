// Tile renderer (#68): consumes `pixel.processed` (push subscription
// pixel.processed.sub) and keeps the raster of every touched tile up to date in
// the private tiles bucket. Subject 3.2, C06 §4.3, docs/data-model.md §4.
//
//   draw worker --pixel.processed--> Pub/Sub --push--> tile-renderer
//        for each tile of the batch:  claim it (tileState) -> raster + new pixels -> PNG
//
// A brush burst is coalesced per tile (state.js): the first message renders at
// once (the pixel shows up within a second or two), the following ones only
// mark the tile dirty, and the leader renders again at most once per
// `minIntervalMs` until nothing is left. Each render reads the old raster and
// only the pixels newer than its version (current.js): the cost follows what
// changed, not the 65 536 pixels of a tile.
import { randomUUID } from "node:crypto";
import { createPushHandler } from "../lib/worker.js";
import { mapLimit, TileConflictError } from "./bucket.js";
import { currentTile } from "./current.js";
import { parseTile, tilesOfPixels } from "./raster.js";

export const FUNCTION_NAME = "tile-renderer";

export class RenderBudgetError extends Error {
  constructor(tile) {
    super(`tile ${tile} still changing after the time budget`);
    this.name = "RenderBudgetError";
  }
}

export class SweepBudgetError extends Error {
  constructor() {
    super("rasters older than the clear still to erase after the time budget");
    this.name = "SweepBudgetError";
  }
}

const MAX_CONFLICT_RETRIES = 3;

/**
 * One render of a tile: stores its current image if it changed.
 * @returns {Promise<"written" | "deleted" | "unchanged">}
 */
export async function renderTile({ bucket, readSession, readPixels }, tx, ty) {
  for (let attempt = 0; ; attempt++) {
    const { clearedAt } = await readSession();
    const current = await currentTile({ bucket, readPixels, tx, ty, clearedAt });
    // An /admin clear committed between the two reads above: the pixels may mix
    // erased ones (filtered with the old clearedAt) and newer ones, so the raster
    // would carry a version after the clear and show erased pixels for good.
    // Read again. A clear committed after this check is harmless: every pixel
    // read is then older than it, so is the version, and the raster is ignored.
    if ((await readSession()).clearedAt !== clearedAt) continue;
    if (current.upToDate) return "unchanged";
    try {
      if (current.blank) {
        // Everything on this tile was erased: no raster means "empty" (404) to the front.
        if (!current.stored) return "unchanged";
        await bucket.remove(tx, ty, { generation: current.stored.generation });
        return "deleted";
      }
      await bucket.write(tx, ty, current.rgba, current.version, { generation: current.stored?.generation });
      return "written";
    } catch (err) {
      // Another renderer wrote the tile meanwhile: start again from its result.
      if (!(err instanceof TileConflictError) || attempt >= MAX_CONFLICT_RETRIES) throw err;
    }
  }
}

/**
 * Brings one tile up to date and keeps doing so until no message is pending.
 * `owner` names the leader in `tileState`: the handler passes the Pub/Sub
 * messageId, which a redelivery keeps. A leader that died without giving the
 * tile back (killed instance, no `release`) then finds its own lease when its
 * message comes back, and takes over at once instead of waiting for the lease to
 * expire while every other message hands its pixels to a leader that no longer exists.
 * @returns {Promise<{ led: boolean, renders: number }>}  led=false: another instance leads this tile and will render our pixels too
 */
export async function syncTile(deps, tile, { minIntervalMs, deadline, now = Date.now, sleep, owner = randomUUID() }) {
  const { state } = deps;
  const { tx, ty } = parseTile(tile);

  const claim = await state.touch(tile, owner);
  if (!claim.leader) return { led: false, renders: 0 };

  let target = claim.seq;
  let renders = 0;
  try {
    for (;;) {
      const startedAt = now();
      await renderTile(deps, tx, ty);
      renders++;

      const checkpoint = await state.checkpoint(tile, owner, target);
      if (checkpoint.done || checkpoint.lost) return { led: true, renders };

      // More messages arrived while rendering: render again, but not more
      // often than minIntervalMs (this is what makes a burst cheap).
      target = checkpoint.seq;
      const wait = Math.max(0, minIntervalMs - (now() - startedAt));
      if (now() + wait > deadline) throw new RenderBudgetError(tile);
      if (wait > 0) await sleep(wait);
    }
  } catch (err) {
    // Hand the tile back so that the retry of this message leads it at once.
    await state.release(tile, owner).catch(() => {});
    throw err;
  }
}

/**
 * @param {object} deps
 * @param {() => Promise<{ state: object, bucket: object, readSession: Function, readPixels: Function }>} deps.getDeps  built lazily
 * @param {{ minIntervalMs: number, budgetMs: number, concurrency: number }} deps.config
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {object} [deps.logger]
 */
export function createTileRenderer({ getDeps, config, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), logger }) {
  return createPushHandler({
    functionName: FUNCTION_NAME,
    expect: "pixel.processed",
    logger,
    async handle({ payload: batch, messageId }, { log }) {
      const deps = await getDeps();
      const deadline = now() + config.budgetMs;

      if (batch.cleared) {
        // /admin clear: every raster rendered before it shows erased pixels.
        const { clearedAt } = await deps.readSession();
        const { erased, complete } = await deps.bucket.deleteStale(clearedAt, { deadline, now });
        log.info("rasters erased after a clear", { batchId: batch.batchId, erased, complete });
        // Out of time: the retry continues where this one stopped (what was erased is not listed as stale again).
        if (!complete) throw new SweepBudgetError();
      }

      const tiles = tilesOfPixels(batch.pixels);
      if (tiles.length === 0) return;

      const results = await mapLimit(tiles, config.concurrency, async (tile) => {
        try {
          if (now() > deadline) throw new RenderBudgetError(tile);
          return { tile, ...(await syncTile(deps, tile, { minIntervalMs: config.minIntervalMs, deadline, now, sleep, owner: messageId || undefined })) };
        } catch (err) {
          return { tile, err };
        }
      });

      const failed = results.filter((r) => r.err);
      log.info("tiles synchronised", {
        batchId: batch.batchId,
        tiles: tiles.length,
        led: results.filter((r) => r.led).length,
        renders: results.reduce((sum, r) => sum + (r.renders ?? 0), 0),
        failed: failed.length,
      });
      // The others are done and idempotent: the retry only redoes what failed.
      if (failed.length > 0) {
        for (const { tile, err } of failed.slice(0, 3)) log.warn("tile not rendered, the message will be retried", { tile, err });
        throw failed[0].err;
      }
    },
  });
}
