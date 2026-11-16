// Entry points of every function. Terraform deploys the same package once per
// function and selects one export with `entry_point`.
import { createPublisher, createSecretReader, initTracing } from "./lib/index.js";
import { createDiscordProxy, FUNCTION_NAME as DISCORD_PROXY } from "./discord/proxy.js";
import { createInteractionClient } from "./lib/discordWebhook.js";
import { getFirestore } from "./lib/firestore.js";
import { loadCommandConfig } from "./commands/config.js";
import { createCommandStore } from "./commands/store.js";
import { createCommandWorker, FUNCTION_NAME as COMMAND_WORKER } from "./commands/worker.js";

export { authDiscord } from "./auth-discord/handler.js";

initTracing();

const secrets = createSecretReader();

// Behind the gateway route GET /health, private like every function.
export function hello(req, res) {
  res.status(200).send("ok");
}

// Temporary backend of the gateway routes whose function is not delivered yet
// (POST /pixels, GET /pixels/{x}/{y}): the route, its JWT check and its IAM
// are already live, the answer is an honest 501. Terraform points each route
// to its real function as soon as it exists (infra/serverless/gateway.tf).
export function notImplemented(req, res) {
  res.set("Cache-Control", "no-store");
  res.status(501).json({ error: "not_implemented" });
}

// Public key of the environment's Discord application. Terraform injects it
// from Secret Manager (secret_env DISCORD_PUBLIC_KEY of infra/serverless);
// without it (local run), it is read with the Secret Manager helper.
export const discordProxy = createDiscordProxy({
  getPublicKey: async () =>
    process.env.DISCORD_PUBLIC_KEY ?? secrets.get(process.env.DISCORD_PUBLIC_KEY_SECRET ?? "discord-public-key"),
  publisher: createPublisher({ source: DISCORD_PROXY }),
});

// Command worker (#64), pushed by discord.command.sub. Built on the first
// message, not at load time: its configuration (admin role and user ids) is
// only set on this function. A bad configuration answers 500, so the messages
// are retried, then dead-lettered, never lost.
let commandHandler;
export function commandWorker(req, res) {
  commandHandler ??= createCommandWorker({
    getStore: async () => createCommandStore(await getFirestore()),
    publisher: createPublisher({ source: COMMAND_WORKER }),
    discord: createInteractionClient(),
    config: loadCommandConfig(),
  });
  return commandHandler(req, res);
}
