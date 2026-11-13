// HTTP entry point of the auth-discord function (issue #67).
//
//   POST  login: Discord code -> our JWT (+ Firebase custom token if enabled),
//         contract in docs/discord-activity.md §2
//   GET   public key set (JWKS) the API Gateway uses to verify our JWT
//   OPTIONS  CORS preflight (API Gateway forwards it, it does not answer it)
//
// The method decides, not the path: the gateway may call the function with or
// without the route path appended. Nothing is persisted, and no token, code,
// verifier or secret is ever written to the logs.

import { createLogger, correlationIdFrom } from "../lib/log.js";
import { loadConfig } from "./config.js";
import { DiscordError, exchangeCode, fetchUser } from "./discord.js";
import { FirebaseTokenError, createFirebaseSigner } from "./firebase.js";
import { jwks, signJwt } from "./jwt.js";

const CODE = /^[A-Za-z0-9._~-]{1,512}$/;
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/; // RFC 7636 §4.1

class BadRequest extends Error {
  constructor(error, reason) {
    super(reason);
    this.error = error; // returned to the client
    this.reason = reason; // logged
  }
}

/** Validates the JSON body; returns only the fields we use. */
function parseLogin(body, redirectUris) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequest("invalid_request", "body_not_json_object");
  const { code, codeVerifier, redirectUri, activity } = body;
  if (typeof code !== "string" || !CODE.test(code)) throw new BadRequest("invalid_request", "bad_code");
  if (typeof codeVerifier !== "string" || !CODE_VERIFIER.test(codeVerifier)) throw new BadRequest("invalid_request", "bad_code_verifier");
  if (activity !== undefined && typeof activity !== "boolean") throw new BadRequest("invalid_request", "bad_activity");

  if (activity === true) {
    // The Activity flow has no redirect: a redirectUri here is a client bug.
    if (redirectUri !== undefined) throw new BadRequest("invalid_request", "redirect_uri_in_activity_flow");
    return { code, codeVerifier, activity: true };
  }
  // Exact match against the allow-list, no normalisation (RFC 6749 §3.1.2.2).
  if (typeof redirectUri !== "string" || !redirectUris.has(redirectUri)) {
    throw new BadRequest("invalid_redirect_uri", "redirect_uri_not_allowed");
  }
  return { code, codeVerifier, redirectUri, activity: false };
}

function setCors(req, res, config) {
  const origin = req.get("origin");
  // Unknown origins get no CORS header (the browser then blocks the response);
  // same-origin calls, like the Activity through the Discord proxy, need none.
  if (origin && config.allowedOrigins.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  }
}

/**
 * @param {object} deps
 * @param {ReturnType<typeof loadConfig>} deps.config
 * @param {typeof fetch} deps.fetch
 * @param {() => number} [deps.now] epoch ms
 * @param {(line: string) => void} [deps.write] log sink
 */
export function createHandler({ config, fetch: fetchFn, now = () => Date.now(), write }) {
  const firebaseToken = config.firebase ? createFirebaseSigner(fetchFn, { ...config.firebase, timeoutMs: config.httpTimeoutMs }, now) : null;

  async function login(req, res, log) {
    let input;
    try {
      input = parseLogin(req.body, config.redirectUris);
    } catch (e) {
      if (!(e instanceof BadRequest)) throw e;
      log.warn("auth.login.rejected", "Login request rejected", { reason: e.reason });
      return res.status(400).json({ error: e.error });
    }
    const flow = input.activity ? "activity" : "web";

    try {
      const accessToken = await exchangeCode(fetchFn, {
        apiUrl: config.discordApiUrl,
        timeoutMs: config.httpTimeoutMs,
        clientId: config.discordClientId,
        clientSecret: config.discordClientSecret,
        code: input.code,
        codeVerifier: input.codeVerifier,
        redirectUri: input.redirectUri,
      });
      const user = await fetchUser(fetchFn, { apiUrl: config.discordApiUrl, timeoutMs: config.httpTimeoutMs, accessToken });

      const iat = Math.floor(now() / 1000);
      const token = signJwt(config.signingKey, {
        iss: config.issuer,
        aud: config.audience,
        sub: user.id,
        username: user.username,
        iat,
        exp: iat + config.ttlSeconds,
        jti: crypto.randomUUID(),
      });

      const response = { token, expiresIn: config.ttlSeconds, user };
      if (firebaseToken) response.firebaseToken = await firebaseToken(user.id, config.ttlSeconds);
      // Only the Activity needs it (sdk.authenticate); it is handed back, never kept.
      if (input.activity) response.discordAccessToken = accessToken;

      log.info("auth.login.succeeded", "User logged in", { user_id: user.id, flow });
      return res.status(200).json(response);
    } catch (e) {
      if (e instanceof DiscordError && e.reason === "invalid_grant") {
        log.warn("auth.login.rejected", "Discord rejected the authorization code", { reason: e.reason, upstream_status: e.status, flow });
        return res.status(401).json({ error: "invalid_grant" });
      }
      if (e instanceof DiscordError || e instanceof FirebaseTokenError) {
        log.error("auth.login.failed", "Upstream call failed", { reason: e.reason, upstream_status: e.status, flow });
        return res.status(502).json({ error: "upstream_error" });
      }
      throw e;
    }
  }

  return async function handle(req, res) {
    const correlationId = correlationIdFrom(req);
    const log = createLogger({ function: config.functionName, correlation_id: correlationId }, write);
    res.set("X-Correlation-Id", correlationId);
    setCors(req, res, config);

    try {
      switch (req.method) {
        case "POST":
          res.set("Cache-Control", "no-store");
          return await login(req, res, log);
        case "GET":
          res.set("Cache-Control", "public, max-age=300");
          return res.status(200).json(jwks(config.signingKey));
        case "OPTIONS":
          res.set("Access-Control-Allow-Methods", "POST, GET");
          res.set("Access-Control-Allow-Headers", "Content-Type, X-Correlation-Id");
          res.set("Access-Control-Max-Age", "600");
          return res.status(204).end();
        default:
          res.set("Allow", "POST, GET, OPTIONS");
          return res.status(405).json({ error: "method_not_allowed" });
      }
    } catch (e) {
      // Our own bug: log the error class and message (ours, never a token).
      log.error("auth.internal_error", "Unexpected error", { error: `${e?.name}: ${String(e?.message).slice(0, 300)}` });
      return res.status(500).json({ error: "server_error" });
    }
  };
}

// Built on the first request of each instance, from the environment.
let handler;

/** Entry point declared in Terraform (entry_point = "authDiscord"). */
export async function authDiscord(req, res) {
  if (!handler) {
    try {
      handler = createHandler({ config: loadConfig(), fetch: globalThis.fetch });
    } catch (e) {
      // Messages from loadConfig name the variable, never its value.
      createLogger({ function: process.env.FUNCTION_NAME ?? "unknown" }).error("auth.config.invalid", "Invalid configuration", { error: String(e?.message).slice(0, 300) });
      res.set("Cache-Control", "no-store");
      return res.status(500).json({ error: "server_error" });
    }
  }
  return handler(req, res);
}
