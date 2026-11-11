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

// Secret name of the environment's Discord public key (set by Terraform).
export const discordProxy = createDiscordProxy({
  getPublicKey: () => secrets.get(process.env.DISCORD_PUBLIC_KEY_SECRET ?? "discord-public-key"),
  publisher: createPublisher({ source: DISCORD_PROXY }),
});
