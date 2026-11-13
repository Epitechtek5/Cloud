// Entry points of every function. Terraform deploys the same package once per
// function and selects one export with `entry_point`.
import { createPublisher, createSecretReader, initTracing } from "./lib/index.js";
import { createDiscordProxy, FUNCTION_NAME as DISCORD_PROXY } from "./discord/proxy.js";

export { authDiscord } from "./auth-discord/handler.js";

initTracing();

const secrets = createSecretReader();

export function hello(req, res) {
  res.status(200).send("ok");
}

// Public key of the environment's Discord application. Terraform injects it
// from Secret Manager (secret_env DISCORD_PUBLIC_KEY of infra/serverless);
// without it (local run), it is read with the Secret Manager helper.
export const discordProxy = createDiscordProxy({
  getPublicKey: async () =>
    process.env.DISCORD_PUBLIC_KEY ?? secrets.get(process.env.DISCORD_PUBLIC_KEY_SECRET ?? "discord-public-key"),
  publisher: createPublisher({ source: DISCORD_PROXY }),
});
