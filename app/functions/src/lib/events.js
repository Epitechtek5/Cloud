// Event schemas of the platform (one per Pub/Sub topic, see docs/pubsub.md).
//
// A tiny declarative validator instead of a dependency: the schemas are small,
// and the error messages stay readable in the logs.

export const GRID_SIZE = 100_000;
export const MAX_PIXELS_PER_BATCH = 256;
export const MAX_COLOR = 0xffffff;

export const EVENT_TYPES = Object.freeze(["discord.command", "pixel.draw", "pixel.processed", "snapshot.requested"]);

// --- schema primitives ------------------------------------------------------

const str = ({ min = 1, max = 256, pattern, optional = false } = {}) => ({ kind: "string", min, max, pattern, optional });
const int = ({ min, max, optional = false } = {}) => ({ kind: "int", min, max, optional });
const bool = ({ optional = false } = {}) => ({ kind: "boolean", optional });
const oneOf = (values, { optional = false } = {}) => ({ kind: "enum", values, optional });
const arrayOf = (item, { min = 0, max = Infinity, optional = false } = {}) => ({ kind: "array", item, min, max, optional });
const object = (fields, { optional = false, nullable = false } = {}) => ({ kind: "object", fields, optional, nullable });
const record = ({ optional = false } = {}) => ({ kind: "record", optional });
const nullable = (schema) => ({ ...schema, nullable: true });

const SNOWFLAKE = /^\d{5,25}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;

const coordinate = int({ min: 0, max: GRID_SIZE - 1 });
const pixel = object({ x: coordinate, y: coordinate, color: int({ min: 0, max: MAX_COLOR }) });
const user = object({ id: str({ pattern: SNOWFLAKE }), name: str({ max: 100, optional: true }) });

// Discord context needed by a worker to answer the interaction later
// (edit the deferred "thinking..." response with the interaction token).
const interaction = object({
  id: str({ pattern: SNOWFLAKE }),
  applicationId: str({ pattern: SNOWFLAKE }),
  token: str({ max: 1024 }),
});

export const SCHEMAS = Object.freeze({
  // Slash command received by the Discord proxy (C07 §1.1).
  "discord.command": object({
    interaction,
    command: str({ max: 32 }),
    subcommand: nullable(str({ max: 32, optional: true })),
    // Flattened options: { x: 10, y: 20, color: "#ff0000" }, user options are ids.
    options: record(),
    guildId: nullable(str({ pattern: SNOWFLAKE, optional: true })),
    channelId: nullable(str({ pattern: SNOWFLAKE, optional: true })),
    user,
    memberRoles: arrayOf(str({ pattern: SNOWFLAKE }), { max: 250 }),
    // Permission bitfield of the member as a decimal string (Discord format).
    memberPermissions: nullable(str({ pattern: /^\d{1,30}$/, optional: true })),
  }),

  // Pixels to draw, from the web proxy (POST /pixels) or the /draw command.
  "pixel.draw": object({
    batchId: str({ pattern: ID }),
    user,
    source: oneOf(["web", "discord"]),
    pixels: arrayOf(pixel, { min: 1, max: MAX_PIXELS_PER_BATCH }),
    // Set when the batch comes from /draw: the worker answers the interaction.
    interaction: object(interaction.fields, { optional: true }),
  }),

  // Pixels written by the draw worker, fanned out to the real-time channel.
  // `/admin clear` empties the whole grid: it is not sent as per-pixel deltas
  // (10^10 pixels) but as `cleared: true` with no pixels; consumers drop their
  // state and reload the rasters.
  "pixel.processed": object({
    batchId: str({ pattern: ID }),
    userId: str({ pattern: SNOWFLAKE }),
    cleared: bool({ optional: true }),
    pixels: arrayOf(pixel, { max: MAX_PIXELS_PER_BATCH }),
    rejected: arrayOf(
      object({ x: coordinate, y: coordinate, reason: oneOf(["rate_limited", "paused", "invalid"]) }),
      { max: MAX_PIXELS_PER_BATCH, optional: true },
    ),
  }),

  // Snapshot of the grid to render and upload (GCS `snapshot.ready` follows).
  "snapshot.requested": object({
    requestId: str({ pattern: ID }),
    requestedBy: str({ pattern: SNOWFLAKE }),
    reason: oneOf(["command", "schedule"]),
    interaction: object(interaction.fields, { optional: true }),
  }),
});

// --- validation -------------------------------------------------------------

function check(schema, value, path, errors) {
  if (value === undefined) {
    if (!schema.optional) errors.push(`${path} is required`);
    return;
  }
  if (value === null) {
    if (!schema.nullable) errors.push(`${path} must not be null`);
    return;
  }
  switch (schema.kind) {
    case "string":
      if (typeof value !== "string") return void errors.push(`${path} must be a string`);
      if (value.length < schema.min || value.length > schema.max)
        errors.push(`${path} must be ${schema.min} to ${schema.max} characters`);
      else if (schema.pattern && !schema.pattern.test(value)) errors.push(`${path} has an invalid format`);
      return;
    case "int":
      if (!Number.isInteger(value)) return void errors.push(`${path} must be an integer`);
      if ((schema.min !== undefined && value < schema.min) || (schema.max !== undefined && value > schema.max))
        errors.push(`${path} must be between ${schema.min} and ${schema.max}`);
      return;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path} must be a boolean`);
      return;
    case "enum":
      if (!schema.values.includes(value)) errors.push(`${path} must be one of ${schema.values.join(", ")}`);
      return;
    case "array":
      if (!Array.isArray(value)) return void errors.push(`${path} must be an array`);
      if (value.length < schema.min || value.length > schema.max)
        errors.push(`${path} must have ${schema.min} to ${schema.max} items`);
      value.forEach((item, i) => check(schema.item, item, `${path}[${i}]`, errors));
      return;
    case "record":
      if (typeof value !== "object" || Array.isArray(value)) errors.push(`${path} must be an object`);
      return;
    case "object":
      if (typeof value !== "object" || Array.isArray(value)) return void errors.push(`${path} must be an object`);
      for (const [key, sub] of Object.entries(schema.fields)) check(sub, value[key], `${path}.${key}`, errors);
      // Object.hasOwn, not `in`: prototype keys (constructor, __proto__, ...) are not fields.
      for (const key of Object.keys(value))
        if (!Object.hasOwn(schema.fields, key)) errors.push(`${path}.${key} is not allowed`);
      return;
    default:
      throw new Error(`unknown schema kind ${schema.kind}`);
  }
}

/**
 * Validates the payload of an event.
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export function validateEvent(eventType, payload) {
  const schema = SCHEMAS[eventType];
  if (!schema) return { ok: false, errors: [`unknown event type ${eventType}`] };
  const errors = [];
  check(schema, payload, "payload", errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export class EventValidationError extends Error {
  constructor(eventType, errors) {
    super(`invalid ${eventType} event: ${errors.join("; ")}`);
    this.name = "EventValidationError";
    this.eventType = eventType;
    this.errors = errors;
  }
}

/** Throws an EventValidationError when the payload does not match its schema. */
export function assertEvent(eventType, payload) {
  const result = validateEvent(eventType, payload);
  if (!result.ok) throw new EventValidationError(eventType, result.errors);
  return payload;
}
