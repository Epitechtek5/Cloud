// Command worker (#64): consumes `discord.command` (push subscription
// discord.command.sub), performs the command and edits the deferred response
// of the interaction. Subject 3.2, C07 §1.2.
//
//   discord-proxy --discord.command--> Pub/Sub --push--> command-worker
//                                                         ├─ /draw      -> pixel.draw (draw worker answers)
//                                                         ├─ /get       -> PNG of the canvas
//                                                         ├─ /snapshot  -> snapshot.requested
//                                                         └─ /admin *   -> session/state, users/{uid}
import { DiscordApiError } from "../lib/discordWebhook.js";
import { createPushHandler } from "../lib/worker.js";
import { handleCommand } from "./commands.js";

export const FUNCTION_NAME = "command-worker";

/**
 * @param {object} deps
 * @param {() => Promise<object>} deps.getStore  command store (store.js), built lazily
 * @param {{ publish: Function }} deps.publisher  allowed on pixel.draw, pixel.processed and snapshot.requested
 * @param {{ editOriginal: Function }} deps.discord  interaction client (lib/discordWebhook.js)
 * @param {object} deps.config  loadCommandConfig()
 * @param {object} [deps.logger]
 */
export function createCommandWorker({ getStore, publisher, discord, config, logger }) {
  return createPushHandler({
    functionName: FUNCTION_NAME,
    expect: "discord.command",
    logger,
    async handle({ payload: event }, { correlationId, log }) {
      const userLog = log.child({ userId: event.user.id });
      const store = await getStore();
      const { authorized, reply } = await handleCommand(event, { store, publisher, config, correlationId });

      if (!authorized) userLog.warn("admin command refused", { command: event.command, subcommand: event.subcommand });
      else userLog.info("command processed", { command: event.command, subcommand: event.subcommand });

      if (!reply) return;
      try {
        await discord.editOriginal(event.interaction, reply);
      } catch (err) {
        // A retryable failure (429, 5xx) is retried by Pub/Sub; the effect is
        // not applied twice (idempotency marker), only the reply is resent.
        if (!(err instanceof DiscordApiError) || err.retryable) throw err;
        // 404: the interaction token expired (15 min). Nothing left to answer.
        userLog.warn("cannot answer the interaction", { status: err.status, command: event.command });
      }
    },
  });
}
