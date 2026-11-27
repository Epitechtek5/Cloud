// Request helpers shared by the web API functions behind the API Gateway
// (POST /pixels, GET /pixels/{x}/{y}).

/**
 * The user the gateway authenticated. The gateway verified the session JWT
 * (signature, iss, aud, exp) and forwards its claims, base64url-encoded JSON,
 * in X-Apigateway-Api-Userinfo. Only the gateway can invoke these functions
 * (roles/run.invoker), so the header cannot come from anyone else; it is still
 * required, so that a route deployed without `security` fails closed (401).
 * @returns {{ id: string, name?: string } | null}
 */
export function gatewayUser(req) {
  const raw = req.get?.("x-apigateway-api-userinfo") ?? req.headers?.["x-apigateway-api-userinfo"];
  if (typeof raw !== "string" || raw === "") return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims?.sub !== "string" || !/^\d{5,25}$/.test(claims.sub)) return null;
  const name = typeof claims.username === "string" && claims.username.length > 0 ? claims.username.slice(0, 100) : undefined;
  return name ? { id: claims.sub, name } : { id: claims.sub };
}

/** Allowed CORS origins from ALLOWED_ORIGINS (JSON array of origins). */
export function parseOrigins(raw) {
  if (raw === undefined || raw.trim() === "") return new Set();
  const list = JSON.parse(raw);
  if (!Array.isArray(list)) throw new Error("ALLOWED_ORIGINS must be a JSON array");
  return new Set(list.map((o) => new URL(o).origin));
}

/**
 * CORS of the browser routes: the gateway only forwards OPTIONS, the function
 * answers it. Unknown origins get no header (the browser blocks the response).
 * @returns {boolean} true when the request was a preflight and is answered
 */
export function cors(req, res, { origins, methods }) {
  const origin = req.get?.("origin");
  if (origin && origins.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  }
  if (req.method !== "OPTIONS") return false;
  res.set("Access-Control-Allow-Methods", methods);
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Correlation-Id");
  res.set("Access-Control-Max-Age", "600");
  res.status(204).end();
  return true;
}
