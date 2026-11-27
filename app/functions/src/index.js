// Entry points of every function. Terraform deploys the same package once per
// function and selects one export with `entry_point`.
import { createPublisher, createSecretReader, initTracing, registerTracingHook } from "./lib/index.js";
import { startOtel, tracingEnabled } from "./lib/otel.js";
import { setTracingReady, tracedHttp } from "./lib/trace.js";
import { createDiscordProxy, FUNCTION_NAME as DISCORD_PROXY } from "./discord/proxy.js";
import { createInteractionClient } from "./lib/discordWebhook.js";
import { getFirestore } from "./lib/firestore.js";
import { loadCommandConfig } from "./commands/config.js";
import { createCommandStore } from "./commands/store.js";
import { createCommandWorker, FUNCTION_NAME as COMMAND_WORKER } from "./commands/worker.js";
import { loadDrawConfig } from "./draw/config.js";
import { createDrawStore } from "./draw/store.js";
import { createDrawWorker, FUNCTION_NAME as DRAW_WORKER } from "./draw/worker.js";
import { createDrawProxy, FUNCTION_NAME as DRAW_PROXY } from "./pixels/drawProxy.js";
import { parseOrigins } from "./pixels/http.js";
import { createPixelReader } from "./pixels/pixelReader.js";
import { getStorage } from "./lib/storage.js";
import { loadNotifierConfig, loadSnapshotWorkerConfig } from "./snapshot/config.js";
import { createSnapshotNotifier, createStorageSigner } from "./snapshot/notifier.js";
import { createSnapshotBucket, readVisiblePixels } from "./snapshot/store.js";
import { createSnapshotWorker } from "./snapshot/worker.js";

import { authDiscord as authDiscordHandler } from "./auth-discord/handler.js";

export const authDiscord = tracedHttp("POST /auth/discord", authDiscordHandler);

// OpenTelemetry SDK and Cloud Trace exporter (#74), on Cloud Run only. Without
// it the spans are no-ops (tests, local runs). Entry points wait for the start;
// a failed start is logged and the functions keep working untraced.
if (tracingEnabled()) registerTracingHook(() => startOtel());
setTracingReady(
  initTracing()?.catch?.((err) =>
    process.stderr.write(`${JSON.stringify({ severity: "WARNING", message: "tracing disabled", error: String(err?.message) })}\n`),
  ),
);

const secrets = createSecretReader();

// Behind the gateway route GET /health, private like every function.
export function hello(req, res) {
  res.status(200).send("ok");
}

// Temporary backend of the gateway routes whose function is not delivered yet
// (GET /tiles/...): the route, its JWT check and its IAM are already live, the
// answer is an honest 501. Terraform points each route to its real function
// as soon as it exists (infra/serverless/gateway.tf).
export function notImplemented(req, res) {
  res.set("Cache-Control", "no-store");
  res.status(501).json({ error: "not_implemented" });
}

// Public key of the environment's Discord application. Terraform injects it
// from Secret Manager (secret_env DISCORD_PUBLIC_KEY of infra/serverless);
// without it (local run), it is read with the Secret Manager helper.
export const discordProxy = tracedHttp(
  "POST /discord/interactions",
  createDiscordProxy({
    getPublicKey: async () =>
      process.env.DISCORD_PUBLIC_KEY ?? secrets.get(process.env.DISCORD_PUBLIC_KEY_SECRET ?? "discord-public-key"),
    publisher: createPublisher({ source: DISCORD_PROXY }),
  }),
);

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

// Draw worker (#65), pushed by pixel.draw.sub: the only writer of the grid.
let drawHandler;
export function drawWorker(req, res) {
  if (!drawHandler) {
    const config = loadDrawConfig();
    drawHandler = createDrawWorker({
      getStore: async () => createDrawStore(await getFirestore(), config),
      publisher: createPublisher({ source: DRAW_WORKER }),
      discord: createInteractionClient(),
    });
  }
  return drawHandler(req, res);
}

// POST /pixels and GET /pixels/{x}/{y} (#66), behind the API Gateway. Built on
// the first request: ALLOWED_ORIGINS (CORS) is only set on these functions.
let drawProxyHandler;
export const drawProxy = tracedHttp("POST /pixels", (req, res) => {
  drawProxyHandler ??= createDrawProxy({
    publisher: createPublisher({ source: DRAW_PROXY }),
    origins: parseOrigins(process.env.ALLOWED_ORIGINS),
  });
  return drawProxyHandler(req, res);
});

let pixelReaderHandler;
export const pixelReader = tracedHttp("GET /pixels/{x}/{y}", (req, res) => {
  pixelReaderHandler ??= createPixelReader({ getDb: getFirestore, origins: parseOrigins(process.env.ALLOWED_ORIGINS) });
  return pixelReaderHandler(req, res);
});

// Snapshot workflow (#69): the worker renders and stores the image (pushed by
// snapshot.requested.sub); the bucket's finalize event, through snapshot.ready,
// triggers the notifier, which posts a signed URL.
let snapshotWorkerHandler;
export function snapshotWorker(req, res) {
  if (!snapshotWorkerHandler) {
    const config = loadSnapshotWorkerConfig();
    snapshotWorkerHandler = createSnapshotWorker({
      readPixels: async () => readVisiblePixels(await getFirestore(), config),
      getBucket: async () => createSnapshotBucket((await getStorage()).bucket(config.bucket)),
    });
  }
  return snapshotWorkerHandler(req, res);
}

let snapshotNotifierHandler;
export async function snapshotNotifier(req, res) {
  if (!snapshotNotifierHandler) {
    const { ttlSeconds } = loadNotifierConfig();
    snapshotNotifierHandler = createSnapshotNotifier({
      signer: createStorageSigner(await getStorage()),
      discord: createInteractionClient(),
      ttlSeconds,
    });
  }
  return snapshotNotifierHandler(req, res);
}
