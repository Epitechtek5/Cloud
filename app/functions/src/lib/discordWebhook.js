// Answers to a Discord interaction from a worker, after the proxy deferred it.
//
// The interaction token (valid 15 minutes) authenticates these calls: no bot
// token is needed to edit the deferred "thinking..." response or to post a
// follow-up (https://discord.com/developers/docs/interactions/receiving-and-responding).
// The token is part of the URL: never log the URL.

import { SpanKind, withSpan } from "./trace.js";

export const DISCORD_API = "https://discord.com/api/v10";

// Never ping anyone from a bot answer (a user name could contain @everyone).
const NO_MENTIONS = { parse: [] };

export class DiscordApiError extends Error {
  constructor(status, reason) {
    super(`Discord API answered ${status}`);
    this.name = "DiscordApiError";
    this.status = status;
    this.reason = reason;
    // 404: unknown or expired interaction token, retrying cannot help.
    this.retryable = status === 429 || status >= 500 || status === 0;
  }
}

function body({ content, files = [], flags }) {
  const payload = { content, allowed_mentions: NO_MENTIONS };
  if (flags !== undefined) payload.flags = flags;
  if (files.length === 0) return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };

  // Attachments: multipart, the JSON in payload_json and each file in files[i].
  payload.attachments = files.map((file, id) => ({ id, filename: file.name, description: file.description }));
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  files.forEach((file, i) => form.append(`files[${i}]`, new Blob([file.data], { type: file.contentType }), file.name));
  return { headers: {}, body: form };
}

/**
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch]
 * @param {string} [options.baseUrl]
 * @param {number} [options.timeoutMs]
 */
export function createInteractionClient({ fetch: fetchFn = globalThis.fetch, baseUrl = DISCORD_API, timeoutMs = 10_000 } = {}) {
  async function call(method, path, message) {
    // The path holds the interaction token: never in a span attribute.
    return withSpan(`discord ${method} webhook`, { kind: SpanKind.CLIENT, attributes: { "http.request.method": method, "server.address": "discord.com" } }, (span) =>
      send(method, path, message, span),
    );
  }

  async function send(method, path, message, span) {
    const request = body(message);
    let res;
    try {
      res = await fetchFn(`${baseUrl}${path}`, { method, ...request, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new DiscordApiError(0, "unreachable");
    }
    span.setAttribute("http.response.status_code", res.status);
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new DiscordApiError(res.status, detail?.code === undefined ? undefined : String(detail.code));
    }
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  const webhook = (interaction) =>
    `/webhooks/${encodeURIComponent(interaction.applicationId)}/${encodeURIComponent(interaction.token)}`;

  return {
    /** Replaces the deferred response ("thinking...") with the result. */
    editOriginal: (interaction, message) => call("PATCH", `${webhook(interaction)}/messages/@original`, message),
    /** Posts a new message in the conversation of the interaction. */
    followUp: (interaction, message) => call("POST", webhook(interaction), message),
  };
}
