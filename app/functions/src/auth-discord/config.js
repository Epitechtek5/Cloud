// Configuration of POST /auth/discord, read once per instance from the
// environment set by Terraform (infra/serverless/auth_discord.tf). Secrets come
// from Secret Manager as environment variables; they are never logged.

import { loadSigningKey } from "./jwt.js";

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`missing ${name}`);
  return value.trim();
}

function requiredInt(env, name, min, max) {
  const n = Number(required(env, name));
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be ${min}..${max}`);
  return n;
}

function requiredUrl(env, name) {
  const value = required(env, name);
  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a URL`);
  }
  return value.replace(/\/+$/, "");
}

/**
 * Exact redirect URIs accepted for the web flow. Only https, plus plain http on
 * localhost for local development; no fragment (RFC 6749 §3.1.2).
 */
export function parseRedirectUris(raw) {
  const list = JSON.parse(raw ?? "[]");
  if (!Array.isArray(list)) throw new Error("ALLOWED_REDIRECT_URIS must be a JSON array");
  for (const uri of list) {
    const u = new URL(uri);
    const local = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
    if ((u.protocol !== "https:" && !local) || u.hash !== "" || uri.includes("#")) {
      throw new Error("ALLOWED_REDIRECT_URIS accepts https URLs (http only on localhost), without fragment");
    }
  }
  return new Set(list);
}

export function loadConfig(env = process.env) {
  const redirectUris = parseRedirectUris(env.ALLOWED_REDIRECT_URIS);
  const firebaseCustomToken = env.FIREBASE_CUSTOM_TOKEN === "true";

  return {
    discordClientId: required(env, "DISCORD_CLIENT_ID"),
    discordClientSecret: required(env, "DISCORD_CLIENT_SECRET"),
    signingKey: loadSigningKey(required(env, "JWT_SIGNING_KEY")),
    issuer: required(env, "JWT_ISSUER"),
    audience: required(env, "JWT_AUDIENCE"),
    ttlSeconds: requiredInt(env, "JWT_TTL_SECONDS", 60, 3600),
    functionName: required(env, "FUNCTION_NAME"),
    discordApiUrl: requiredUrl(env, "DISCORD_API_URL"),
    httpTimeoutMs: requiredInt(env, "HTTP_TIMEOUT_MS", 100, 60_000),
    redirectUris,
    // CORS: the web front calls the gateway from the origin it redirects to.
    allowedOrigins: new Set([...redirectUris].map((uri) => new URL(uri).origin)),
    firebaseCustomToken,
    // Only read when the Firebase custom token is on.
    firebase: firebaseCustomToken
      ? {
          metadataUrl: requiredUrl(env, "GCE_METADATA_URL"),
          iamCredentialsUrl: requiredUrl(env, "IAM_CREDENTIALS_URL"),
          audience: required(env, "FIREBASE_TOKEN_AUDIENCE"),
        }
      : null,
  };
}
