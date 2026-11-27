// Tile reader (#68, question A of docs/frontend-contract.md): serves
// `GET /tiles/{tx}/{ty}.png` from the private tiles bucket.
//
// The bucket stays private: this function is the only reader, with a role on
// that bucket alone. It sits behind the front's load balancer and Cloud CDN
// (same origin as the app, so no CORS), whose cache does the heavy lifting:
// the function is reached once per tile and `max-age`, not once per viewer.
//
// What the front expects (app/frontend/src/backend/gcp/tiles.ts):
//   200  image/png, 256 x 256, alpha 0 where nothing was painted, X-Tile-Version
//   404  nothing painted on this tile (or erased): the front then reads every pixel from Firestore
// X-Tile-Version is read from the PNG itself (a tEXt chunk), so the version
// always belongs to the bytes sent, even while the renderer overwrites the tile.
import { httpContext } from "../lib/context.js";
import { PngError } from "../lib/pngDecode.js";
import { inTileGrid, rasterVersion, tileName } from "./raster.js";

export const FUNCTION_NAME = "tile-reader";

// The load balancer forwards the path unchanged; the gateway route (option 1) appends it to the function URL.
const PATH = /\/tiles\/(\d{1,3})\/(\d{1,3})\.png$/;

/** Nothing painted here (or erased): the contract's 404 with version 0. */
function missing(res, config) {
  res.set("Cache-Control", `public, max-age=${config.missingMaxAgeSeconds}`);
  res.set("X-Tile-Version", "0");
  return res.status(404).json({ error: "not_found" });
}

/**
 * `session/state.clearedAt` with a short per-instance cache: the reader is hit
 * on every CDN miss, a clear is rare. A failed read is not cached.
 */
export function cacheClearedAt(read, { ttlMs = 5000, now = Date.now } = {}) {
  let cached;
  return async () => {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    const value = await read();
    cached = { value, at: now() };
    return value;
  };
}

/**
 * @param {object} deps
 * @param {() => Promise<import("@google-cloud/storage").Bucket>} deps.getBucket
 * @param {() => Promise<number>} deps.getClearedAt  epoch ms of the last /admin clear (0: never)
 * @param {{ maxAgeSeconds: number, missingMaxAgeSeconds: number }} deps.config
 * @param {Set<string>} [deps.origins]  CORS allow-list (empty: same origin only)
 * @param {object} [deps.logger]
 */
export function createTileReader({ getBucket, getClearedAt, config, origins = new Set(), logger }) {
  return async function tileReader(req, res) {
    const { correlationId, log } = httpContext(req, { functionName: FUNCTION_NAME, logger });
    res.set("X-Correlation-Id", correlationId);
    res.set("X-Content-Type-Options", "nosniff");
    // The version must be readable by a script on another origin.
    res.set("Access-Control-Expose-Headers", "X-Tile-Version");
    const origin = req.get?.("origin");
    if (origin && origins.has(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
    }

    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "GET, HEAD");
      res.set("Access-Control-Max-Age", "600");
      return res.status(204).end();
    }
    if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).set("Allow", "GET, HEAD, OPTIONS").json({ error: "method_not_allowed" });

    const match = PATH.exec((req.path ?? req.url ?? "").split("?")[0]);
    const tx = match ? Number(match[1]) : NaN;
    const ty = match ? Number(match[2]) : NaN;
    if (!inTileGrid(tx, ty)) {
      res.set("Cache-Control", `public, max-age=${config.missingMaxAgeSeconds}`);
      return res.status(404).json({ error: "not_found" });
    }

    // A raster rendered before the last /admin clear shows erased pixels: it is
    // never served, whether or not the renderer already swept it. Read first,
    // so that a clear racing with this request can only make us stricter.
    let clearedAt;
    try {
      clearedAt = await getClearedAt();
    } catch (err) {
      log.error("cannot read the grid generation", { err });
      res.set("Cache-Control", "no-store");
      return res.status(503).json({ error: "unavailable" });
    }

    let png;
    try {
      [png] = await (await getBucket()).file(tileName(tx, ty)).download();
    } catch (err) {
      if (err?.code !== 404) {
        log.error("cannot read the tile", { err, tx, ty });
        res.set("Cache-Control", "no-store");
        return res.status(503).json({ error: "unavailable" });
      }
      return missing(res, config);
    }

    let version;
    try {
      version = rasterVersion(png);
    } catch (err) {
      if (!(err instanceof PngError)) throw err;
      // Never serve a raster without its version: the front would subscribe from the wrong point.
      log.error("tile without a valid version", { err, tx, ty });
      res.set("Cache-Control", "no-store");
      return res.status(503).json({ error: "unavailable" });
    }

    if (version <= clearedAt) return missing(res, config);

    res.set("Content-Type", "image/png");
    res.set("X-Tile-Version", String(version));
    res.set("Cache-Control", `public, max-age=${config.maxAgeSeconds}`);
    return res.status(200).send(png);
  };
}
