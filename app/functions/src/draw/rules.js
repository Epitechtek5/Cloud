// Business rules of the draw worker, without I/O (unit tested): rate limit
// window and the outcome of a batch. The Firestore transaction (store.js)
// feeds them the documents it read.

/**
 * Fixed-window rate limit of one user (subject 3.3: 20 pixels per minute by
 * default, `/admin ratelimit` override).
 *
 * @param {object} input
 * @param {{ used?: number, windowStart?: number|null, override?: number|null }} input.user  users/{uid} (windowStart in epoch ms)
 * @param {number} input.requested  pixels asking for quota
 * @param {number} input.now  epoch ms
 * @param {number} input.defaultLimit
 * @param {number} input.windowMs
 * @returns {{ granted: number, limit: number, used: number, windowStart: number, retryAfterMs: number }}
 */
export function applyRateLimit({ user, requested, now, defaultLimit, windowMs }) {
  const limit = Number.isInteger(user?.override) && user.override >= 0 ? user.override : defaultLimit;
  const fresh = !Number.isFinite(user?.windowStart) || now - user.windowStart >= windowMs || now < user.windowStart;
  const windowStart = fresh ? now : user.windowStart;
  const usedBefore = fresh ? 0 : Math.max(0, user.used ?? 0);
  const granted = Math.max(0, Math.min(requested, limit - usedBefore));
  return {
    granted,
    limit,
    used: usedBefore + granted,
    windowStart,
    retryAfterMs: granted < requested ? Math.max(0, windowStart + windowMs - now) : 0,
  };
}

/**
 * Pixels of a batch, deduplicated: drawing the same pixel twice in one batch
 * writes it once (the last colour wins) and uses one unit of quota.
 */
export function uniquePixels(pixels) {
  const byKey = new Map();
  for (const p of pixels) {
    const key = `${p.x}_${p.y}`;
    byKey.delete(key); // keep the order of the last occurrence
    byKey.set(key, p);
  }
  return [...byKey.values()];
}

/**
 * Splits a batch into accepted and rejected pixels.
 * @returns {{ accepted: object[], rejected: object[], reason: "paused"|"rate_limited"|null, quota: object|null }}
 */
export function decideBatch({ pixels, paused, user, now, defaultLimit, windowMs }) {
  const unique = uniquePixels(pixels);
  if (paused) return { accepted: [], rejected: unique, reason: "paused", quota: null };
  const quota = applyRateLimit({ user, requested: unique.length, now, defaultLimit, windowMs });
  const accepted = unique.slice(0, quota.granted);
  const rejected = unique.slice(quota.granted);
  return { accepted, rejected, reason: rejected.length > 0 ? "rate_limited" : null, quota };
}

/** Answer to /draw (one pixel), from the outcome of its batch. */
export function drawReply({ accepted, reason, quota }, pixel) {
  const where = `(${pixel.x}, ${pixel.y})`;
  if (accepted.length > 0) return { content: `🎨 Pixel ${where} painted #${pixel.color.toString(16).padStart(6, "0")}.` };
  if (reason === "paused") return { content: `⏸️ Drawing is paused, pixel ${where} was not painted.` };
  const seconds = Math.ceil((quota?.retryAfterMs ?? 0) / 1000);
  return { content: `⏱️ Rate limit reached (${quota?.limit ?? 0} pixels per minute), try again in ${seconds} s.` };
}
