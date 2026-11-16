// Fakes of the command worker dependencies.
import { createPublisher } from "../../src/lib/publisher.js";
import { valid } from "../lib/fixtures.js";

export const ADMIN_ROLE = "1000000000000000099";
export const ADMIN_USER = "1000000000000000098";
export const config = {
  adminRoleIds: new Set([ADMIN_ROLE]),
  adminUserIds: new Set([ADMIN_USER]),
  appUrl: "https://canvas.test/",
  getDefaultSize: 128,
};

/** A `discord.command` event; `roles` defaults to none (not an admin). */
export function command(name, { subcommand = null, options = {}, roles = [], userId = valid["discord.command"].user.id, id } = {}) {
  const base = valid["discord.command"];
  return {
    ...base,
    interaction: { ...base.interaction, ...(id ? { id } : {}) },
    command: name,
    subcommand,
    options,
    user: { ...base.user, id: userId },
    memberRoles: roles,
    // Discord says Administrator: the worker must not care.
    memberPermissions: "8",
  };
}

/** In-memory store with the interface of src/commands/store.js. */
export function fakeStore({ session = { paused: false, clearedAt: 0 }, pixels = [] } = {}) {
  const markers = new Map();
  const state = { session: { ...session }, users: {}, clears: 0, regions: [] };
  const once = (id, info, apply) => {
    if (markers.has(id)) return { duplicate: true, reply: markers.get(id).reply };
    const reply = apply();
    markers.set(id, { ...info, reply });
    return { duplicate: false, reply };
  };
  return {
    state,
    markers,
    processed: async (id) => (markers.has(id) ? { reply: markers.get(id).reply } : null),
    markProcessed: async (id, info, reply) => once(id, info, () => reply),
    setPaused: async (id, info, paused, reply) => once(id, info, () => ((state.session.paused = paused), reply)),
    clear: async (id, info, reply) => once(id, info, () => (state.clears++, reply)),
    setRateLimit: async (id, info, uid, limit, reply) => once(id, info, () => ((state.users[uid] = limit), reply)),
    readSession: async () => state.session,
    readRegion: async (region) => (state.regions.push(region), pixels),
  };
}

/** A real publisher (schemas validated) on a fake Pub/Sub client. */
export function fakePublisher({ fail } = {}) {
  const published = [];
  const client = {
    topic: (name) => ({
      publishMessage: async (msg) => {
        if (fail) throw fail;
        published.push({ topic: name, payload: msg.json, attributes: msg.attributes });
        return `m${published.length}`;
      },
    }),
  };
  return { publisher: createPublisher({ source: "test", client }), published };
}

/** Records the answers sent to Discord. */
export function fakeDiscord({ fail } = {}) {
  const edits = [];
  return {
    edits,
    editOriginal: async (interaction, message) => {
      if (fail) throw fail;
      edits.push({ interaction, message });
    },
  };
}

/** A Pub/Sub push request carrying `payload`. */
export function pushRequest(eventType, payload, { attributes = {}, data } = {}) {
  return {
    method: "POST",
    headers: {},
    body: {
      message: {
        data: data ?? Buffer.from(JSON.stringify(payload)).toString("base64"),
        attributes: { event_type: eventType, correlation_id: "corr-12345678", ...attributes },
        messageId: "1",
      },
      subscription: "projects/p/subscriptions/x",
      deliveryAttempt: 1,
    },
  };
}
