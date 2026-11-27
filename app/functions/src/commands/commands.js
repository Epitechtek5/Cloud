// What each slash command does (C07 §1.2). The worker (worker.js) decodes the
// message and sends the reply; this module decides the effect and the reply.
//
// A reply is `{ content, files? }` (edits the deferred response), or null when
// another worker answers (the draw worker answers /draw).
import { parseColor } from "../lib/colors.js";
import { GRID_SIZE } from "../lib/events.js";
import { inGrid } from "../lib/grid.js";
import { encodePng } from "../lib/png.js";
import { renderRegion } from "../lib/canvas.js";
import { snowflakeTime } from "../lib/snowflake.js";
import { isAdmin, requiresAdmin } from "./authorize.js";

export const REPLIES = Object.freeze({
  forbidden: "⛔ You are not allowed to use this command.",
  unknown: "Unknown command.",
  paused: "⏸️ Drawing is paused for everyone.",
  resumed: "▶️ Drawing is resumed.",
  cleared: "🧹 The canvas has been cleared.",
  snapshot: "📸 Snapshot requested, the link will be posted here in a moment.",
});

// /get renders a square of the grid; the image is scaled up to at least this.
const GET_MIN_IMAGE = 512;
const GET_MAX_SIZE = 512;

function clampInt(value, min, max, fallback) {
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** /draw x y color: one pixel through the same pipeline as the web (pixel.draw). */
async function draw(event, { publisher, correlationId }) {
  const { x, y, color } = event.options;
  if (!inGrid(x, y)) return { content: `❌ Coordinates must be between 0 and ${GRID_SIZE - 1}.` };
  const rgb = parseColor(color);
  if (rgb === null) return { content: "❌ Unknown colour: use #RRGGBB or a palette name (red, blue, ...)." };
  await publisher.publish(
    "pixel.draw",
    {
      // The interaction id makes the batch id stable: a redelivered command
      // publishes the same batch, which the draw worker applies only once.
      batchId: `discord-${event.interaction.id}`,
      user: event.user,
      source: "discord",
      pixels: [{ x, y, color: rgb }],
      interaction: event.interaction,
    },
    { correlationId },
  );
  return null; // the draw worker edits the response with the outcome
}

/** /get [x] [y] [size]: PNG of a square of the canvas, centred like the web app opens. */
async function get(event, { store, config }) {
  const size = clampInt(event.options.size, 16, GET_MAX_SIZE, config.getDefaultSize);
  const cx = clampInt(event.options.x, 0, GRID_SIZE - 1, GRID_SIZE / 2);
  const cy = clampInt(event.options.y, 0, GRID_SIZE - 1, GRID_SIZE / 2);
  const x0 = Math.min(Math.max(0, cx - Math.floor(size / 2)), GRID_SIZE - size);
  const y0 = Math.min(Math.max(0, cy - Math.floor(size / 2)), GRID_SIZE - size);

  const { clearedAt } = await store.readSession();
  const { pixels, truncated } = await store.readRegion({ x0, y0, size, clearedAt });
  const scale = Math.max(1, Math.ceil(GET_MIN_IMAGE / size));
  const image = renderRegion(pixels, { x0, y0, width: size, height: size, scale });
  const png = encodePng(image.width, image.height, image.rgba, { text: { Title: `canvas ${x0},${y0} ${size}x${size}` } });

  const link = config.appUrl ? `\nOpen the canvas: ${config.appUrl}` : "";
  const partial = truncated ? "\n⚠️ This area is too busy to read in full: some pixels are missing, use a smaller size." : "";
  return {
    content: `🖼️ Canvas from (${x0}, ${y0}) to (${x0 + size - 1}, ${y0 + size - 1}), ${pixels.length} painted pixel(s).${partial}${link}`,
    files: [{ name: "canvas.png", contentType: "image/png", data: png, description: `Canvas ${x0},${y0} ${size}x${size}` }],
  };
}

/** /snapshot: hands over to the snapshot workflow (snapshot.requested). */
async function snapshot(event, { store, publisher, correlationId, info }) {
  const reply = { content: REPLIES.snapshot };
  const done = await store.processed(event.interaction.id);
  if (done) return done.reply;
  await publisher.publish(
    "snapshot.requested",
    {
      requestId: event.interaction.id,
      requestedBy: event.user.id,
      reason: "command",
      // From the interaction id: the same on a redelivery, so the snapshot
      // worker writes the same object name and the notifier posts once.
      requestedAt: snowflakeTime(event.interaction.id),
      interaction: event.interaction,
      ...(event.channelId ? { channelId: event.channelId } : {}),
    },
    { correlationId },
  );
  return (await store.markProcessed(event.interaction.id, info, reply)).reply;
}

async function admin(event, { store, publisher, correlationId, info }) {
  const id = event.interaction.id;
  switch (event.subcommand) {
    case "pause":
      return (await store.setPaused(id, info, true, { content: REPLIES.paused })).reply;
    case "resume":
      return (await store.setPaused(id, info, false, { content: REPLIES.resumed })).reply;
    case "clear": {
      const { reply } = await store.clear(id, info, { content: REPLIES.cleared });
      // Fan-out of the clear (tile renderer, real-time): one signal, never
      // 10^10 per-pixel deltas. Same batch id on a redelivery.
      await publisher.publish(
        "pixel.processed",
        { batchId: `clear-${id}`, userId: event.user.id, cleared: true, pixels: [] },
        { correlationId },
      );
      return reply;
    }
    case "ratelimit": {
      const { user, limit } = event.options;
      if (typeof user !== "string" || !/^\d{5,25}$/.test(user) || !Number.isInteger(limit) || limit < 0 || limit > 1000)
        return { content: "❌ Usage: /admin ratelimit user:<user> limit:<0..1000>." };
      const reply = { content: `⏱️ <@${user}> can now draw ${limit} pixel(s) per minute.` };
      return (await store.setRateLimit(id, info, user, limit, reply)).reply;
    }
    default:
      return { content: REPLIES.unknown };
  }
}

const HANDLERS = { draw, get, snapshot, admin };

/**
 * @param {object} event  a valid `discord.command` event
 * @param {object} deps  { store, publisher, config, correlationId }
 * @returns {Promise<{ authorized: boolean, reply: object | null }>}
 */
export async function handleCommand(event, deps) {
  if (requiresAdmin(event.command) && !isAdmin(event, deps.config)) return { authorized: false, reply: { content: REPLIES.forbidden } };
  const handler = HANDLERS[event.command];
  if (!handler) return { authorized: true, reply: { content: REPLIES.unknown } };
  const info = { command: event.command, subcommand: event.subcommand ?? null, userId: event.user.id };
  return { authorized: true, reply: await handler(event, { ...deps, info }) };
}
