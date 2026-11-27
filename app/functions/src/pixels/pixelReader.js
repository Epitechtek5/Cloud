// GET /pixels/{x}/{y} (#66): who painted a pixel, with which colour, and when.
// Read-only and outside the broker (no side effect, frontend contract §1). Its
// service account only has roles/datastore.viewer.
import { readSession, isVisible } from "../lib/canvas.js";
import { httpContext } from "../lib/context.js";
import { toMillis } from "../lib/firestore.js";
import { COLLECTIONS, inGrid, pixelId } from "../lib/grid.js";
import { cors, gatewayUser } from "./http.js";
import { firestoreSpan } from "../lib/trace.js";

export const FUNCTION_NAME = "pixel-reader";

// The gateway appends the request path to the function URL.
const PATH = /\/pixels\/(\d{1,5})\/(\d{1,5})\/?$/;

/** Reads one pixel; null when never painted or erased by /admin clear. */
export async function readPixel(db, x, y) {
  const [snap, { clearedAt }] = await Promise.all([db.collection(COLLECTIONS.pixels).doc(pixelId(x, y)).get(), readSession(db)]);
  if (!snap.exists) return null;
  const p = snap.data();
  if (!isVisible(p, clearedAt)) return null;
  return { x, y, color: p.c, author: p.a, authorName: p.an ?? p.a, ts: toMillis(p.t) };
}

/**
 * @param {object} deps
 * @param {() => Promise<object>} deps.getDb
 * @param {Set<string>} deps.origins
 * @param {object} [deps.logger]
 */
export function createPixelReader({ getDb, origins, logger }) {
  return async function pixelReader(req, res) {
    const { correlationId, log } = httpContext(req, { functionName: FUNCTION_NAME, logger });
    res.set("X-Correlation-Id", correlationId);
    res.set("Cache-Control", "no-store");
    if (cors(req, res, { origins, methods: "GET" })) return;
    if (req.method !== "GET") return res.status(405).set("Allow", "GET, OPTIONS").json({ error: "method_not_allowed" });
    if (!gatewayUser(req)) return res.status(401).json({ error: "unauthorized" });

    const match = PATH.exec((req.path ?? req.url ?? "").split("?")[0]);
    const x = match ? Number(match[1]) : NaN;
    const y = match ? Number(match[2]) : NaN;
    if (!inGrid(x, y)) return res.status(400).json({ error: "invalid_request" });

    try {
      const db = await getDb();
      const pixel = await firestoreSpan("get pixel", () => readPixel(db, x, y));
      if (!pixel) return res.status(404).json({ error: "not_found" });
      return res.status(200).json(pixel);
    } catch (err) {
      log.error("cannot read the pixel", { err, x, y });
      return res.status(503).json({ error: "unavailable" });
    }
  };
}
