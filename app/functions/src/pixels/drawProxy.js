// POST /pixels (#66): the web side of drawing (subject 3.4, frontend contract
// §1). Validates, publishes ONE pixel.draw event and answers 202 without
// waiting: no Firestore access at all (its service account has none), the
// draw worker does the rest and the result comes back in real time.
import { httpContext } from "../lib/context.js";
import { validateEvent } from "../lib/events.js";
import { cors, gatewayUser } from "./http.js";

export const FUNCTION_NAME = "draw-proxy";

/**
 * @param {object} deps
 * @param {{ publish: Function }} deps.publisher  allowed on pixel.draw only
 * @param {Set<string>} deps.origins  CORS allow-list
 * @param {object} [deps.logger]
 */
export function createDrawProxy({ publisher, origins, logger }) {
  return async function drawProxy(req, res) {
    const { correlationId, log } = httpContext(req, { functionName: FUNCTION_NAME, logger });
    res.set("X-Correlation-Id", correlationId);
    res.set("Cache-Control", "no-store");
    if (cors(req, res, { origins, methods: "POST" })) return;
    if (req.method !== "POST") return res.status(405).set("Allow", "POST, OPTIONS").json({ error: "method_not_allowed" });

    const user = gatewayUser(req);
    if (!user) {
      log.warn("request without an authenticated user");
      return res.status(401).json({ error: "unauthorized" });
    }

    const body = req.body;
    const event = {
      batchId: body?.batchId,
      user,
      source: "web",
      pixels: body?.pixels,
    };
    const extra = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).filter((k) => k !== "batchId" && k !== "pixels") : [];
    const result = validateEvent("pixel.draw", event);
    if (!result.ok || extra.length > 0) {
      // Paths only (payload.pixels[3].x ...), never the values.
      const errors = [...(result.errors ?? []), ...extra.map((k) => `payload.${k} is not allowed`)].map((e) => e.replace(/^payload\./, ""));
      log.warn("invalid draw request", { userId: user.id, errors: errors.slice(0, 10) });
      return res.status(400).json({ error: "invalid_request", details: errors.slice(0, 10) });
    }

    try {
      const { messageId } = await publisher.publish("pixel.draw", event, { correlationId });
      log.info("batch accepted", { userId: user.id, batchId: event.batchId, pixels: event.pixels.length, messageId });
    } catch (err) {
      log.error("cannot publish the batch", { err, userId: user.id, batchId: event.batchId });
      return res.status(503).json({ error: "unavailable" });
    }
    return res.status(202).json({ batchId: event.batchId });
  };
}
