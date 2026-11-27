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

const MAX_CONFLICT_RETRIES = 3;

/**
 * One render of a tile: stores its current image if it changed.
 * @returns {Promise<"written" | "deleted" | "unchanged">}
 */
export async function renderTile({ bucket, readSession, readPixels }, tx, ty) {
  for (let attempt = 0; ; attempt++) {
    const { clearedAt } = await readSession();
    const current = await currentTile({ bucket, readPixels, tx, ty, clearedAt });
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
 * @returns {Promise<{ led: boolean, renders: number }>}  led=false: another instance leads this tile and will render our pixels too
 */
export async function syncTile(deps, tile, { minIntervalMs, deadline, now = Date.now, sleep }) {
  const { state } = deps;
  const owner = randomUUID();
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
    async handle({ payload: batch }, { log }) {
      const deps = await getDeps();
      const deadline = now() + config.budgetMs;

      if (batch.cleared) {
        // /admin clear: every raster rendered before it shows erased pixels.
        const { clearedAt } = await deps.readSession();
        const erased = await deps.bucket.deleteStale(clearedAt);
        log.info("rasters erased after a clear", { batchId: batch.batchId, erased });
      }

      const tiles = tilesOfPixels(batch.pixels);
      if (tiles.length === 0) return;

      const results = await mapLimit(tiles, config.concurrency, async (tile) => {
        try {
          if (now() > deadline) throw new RenderBudgetError(tile);
          return { tile, ...(await syncTile(deps, tile, { minIntervalMs: config.minIntervalMs, deadline, now, sleep })) };
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
