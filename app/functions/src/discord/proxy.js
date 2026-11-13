// Discord interactions proxy (subject 3.2, C06 Hands-on 3).
//
// Thin public entry point behind the API Gateway: verify the signature, answer
// PING, acknowledge commands with a deferred response and publish them on
// `discord.command`. No business logic, no grid write: the command worker does
// the work and edits the deferred response with the interaction token.
import { httpContext } from "../lib/context.js";
import { publicKeyFromHex, verifyDiscordRequest } from "./verify.js";
import { deferredResponse, InteractionType, ResponseType, toCommandEvent } from "./interaction.js";

export const FUNCTION_NAME = "discord-proxy";

/**
 * @param {object} deps
 * @param {() => Promise<string>} deps.getPublicKey  hex public key of the environment's Discord application
 * @param {{ publish: Function }} deps.publisher  publisher allowed on `discord.command` only
 * @param {object} [deps.logger]
 * @param {() => number} [deps.now]
 */
export function createDiscordProxy({ getPublicKey, publisher, logger, now = Date.now }) {
  let keyPromise;
  const publicKey = () => {
    if (!keyPromise) {
      keyPromise = getPublicKey().then(publicKeyFromHex);
      // A failed read must not stick: the next request retries.
      keyPromise.catch(() => (keyPromise = undefined));
    }
    return keyPromise;
  };

  return async function discordProxy(req, res) {
    const { correlationId, log } = httpContext(req, { functionName: FUNCTION_NAME, logger });
    res.set("X-Correlation-Id", correlationId);

    if (req.method !== "POST") return res.status(405).set("Allow", "POST").send("method not allowed");

    // 1. Signature first, before parsing or trusting anything in the body.
    let key;
    try {
      key = await publicKey();
    } catch (err) {
      log.error("cannot load the Discord public key", { err });
      return res.status(500).send("unavailable");
    }
    const valid = verifyDiscordRequest(key, {
      signature: req.get("X-Signature-Ed25519"),
      timestamp: req.get("X-Signature-Timestamp"),
      rawBody: req.rawBody,
      now: now(),
    });
    if (!valid) {
      log.warn("invalid Discord signature");
      return res.status(401).send("invalid request signature");
    }

    let interaction;
    try {
      interaction = typeof req.body === "object" && req.body !== null ? req.body : JSON.parse(req.rawBody.toString("utf8"));
    } catch {
      return res.status(400).send("invalid JSON");
    }

    // 2. PING -> PONG (Discord's endpoint validation).
    if (interaction.type === InteractionType.PING) {
      log.info("PING");
      return res.status(200).json({ type: ResponseType.PONG });
    }

    // 3. Slash command: publish, then the deferred ack (well within the 3 s budget).
    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      const event = toCommandEvent(interaction);
      const userLog = log.child({ userId: event.user.id, eventType: "discord.command" });
      try {
        // Published before answering: once the response is sent the instance
        // may lose its CPU, and the command would be lost.
        const { messageId } = await publisher.publish("discord.command", event, { correlationId });
        userLog.info("command accepted", { command: event.command, subcommand: event.subcommand, messageId });
      } catch (err) {
        userLog.error("cannot publish the command", { err, command: event.command });
        return res.status(500).send("unavailable");
      }
      return res.status(200).json(deferredResponse(event.command));
    }

    log.warn("unsupported interaction type", { interactionType: interaction.type });
    return res.status(400).send("unsupported interaction type");
  };
}
