import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { createHandler, authDiscord } from "../src/auth-discord/handler.js";
import { loadConfig, parseRedirectUris } from "../src/auth-discord/config.js";
import { loadSigningKey, signJwt, jwks } from "../src/auth-discord/jwt.js";

const pem = (type, opts) => generateKeyPairSync(type, opts).privateKey.export({ type: "pkcs8", format: "pem" });
const EC_PEM = pem("ec", { namedCurve: "P-256" });

const SECRET = "client-secret-xyz";
const CODE = "discordAuthCode123";
const VERIFIER = "v".repeat(20) + "-._~" + "A1".repeat(12); // 48 chars, RFC 7636 charset
const ACCESS = "discord-access-token-abc";
const REFRESH = "discord-refresh-token-def";
const WEB_REDIRECT = "https://app.example.com/";
const NOW = 1_700_000_000_000;

function env(overrides = {}) {
  return {
    DISCORD_CLIENT_ID: "1562814087900037260",
    DISCORD_CLIENT_SECRET: SECRET,
    JWT_SIGNING_KEY: EC_PEM,
    JWT_ISSUER: "urn:test:auth",
    JWT_AUDIENCE: "urn:test:api",
    JWT_TTL_SECONDS: "600",
    FUNCTION_NAME: "auth-discord",
    DISCORD_API_URL: "https://discord.com/api/v10",
    HTTP_TIMEOUT_MS: "5000",
    GCE_METADATA_URL: "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default",
    IAM_CREDENTIALS_URL: "https://iamcredentials.googleapis.com/v1",
    FIREBASE_TOKEN_AUDIENCE: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
    ALLOWED_REDIRECT_URIS: JSON.stringify([WEB_REDIRECT, "http://localhost:5173/"]),
    ...overrides,
  };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Fake fetch: answers by URL, records every call. */
function fakeFetch(routes = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const route = Object.keys(routes).find((prefix) => String(url).startsWith(prefix));
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return routes[route](init);
  };
  fn.calls = calls;
  return fn;
}

const discordOk = (scope = "identify") => ({
  "https://discord.com/api/v10/oauth2/token": () =>
    json(200, { access_token: ACCESS, token_type: "Bearer", expires_in: 604800, refresh_token: REFRESH, scope }),
  "https://discord.com/api/v10/users/@me": () => json(200, { id: "42", username: "alice", global_name: "Alice" }),
});

function fakeReq({ method = "POST", body, headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method, body, headers: lower, get: (name) => lower[name.toLowerCase()] };
}

function fakeRes() {
  const res = { statusCode: undefined, headers: {}, body: undefined, ended: false };
  res.set = (k, v) => ((res.headers[k.toLowerCase()] = v), res);
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (b) => ((res.body = b), (res.ended = true), res);
  res.send = (b) => ((res.body = b), (res.ended = true), res);
  res.end = () => ((res.ended = true), res);
  return res;
}

/** Runs one request; returns the response, the fetch calls and the log lines. */
async function run({ envOverrides, routes = discordOk(), req }) {
  const lines = [];
  const fetch = fakeFetch(routes);
  const handler = createHandler({ config: loadConfig(env(envOverrides)), fetch, now: () => NOW, write: (l) => lines.push(l) });
  const res = fakeRes();
  await handler(fakeReq(req), res);
  return { res, calls: fetch.calls, lines };
}

const webBody = (o = {}) => ({ code: CODE, codeVerifier: VERIFIER, redirectUri: WEB_REDIRECT, activity: false, ...o });
const activityBody = (o = {}) => ({ code: CODE, codeVerifier: VERIFIER, activity: true, ...o });

function decodeAndVerify(token, jwkSet) {
  const [h, p, s] = token.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url"));
  const jwk = jwkSet.keys.find((k) => k.kid === header.kid);
  assert.ok(jwk, "kid must be in the JWKS");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const opts = header.alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key;
  assert.ok(verify("sha256", Buffer.from(`${h}.${p}`), opts, Buffer.from(s, "base64url")), "signature must verify");
  return { header, claims: JSON.parse(Buffer.from(p, "base64url")) };
}

/** Nothing sensitive may reach the logs, whatever the outcome. */
function assertNoSecretInLogs(lines, res) {
  const all = lines.join("\n");
  const forbidden = [SECRET, CODE, VERIFIER, ACCESS, REFRESH, "PRIVATE KEY"];
  if (typeof res?.body?.token === "string") forbidden.push(res.body.token);
  for (const value of forbidden) assert.ok(!all.includes(value), `log leaks ${value}`);
  for (const line of lines) JSON.parse(line); // every entry is structured JSON
}

describe("POST web flow", () => {
  test("exchanges the code with redirect_uri and returns our JWT, without the Discord token", async () => {
    const { res, calls, lines } = await run({ req: { body: webBody(), headers: { "X-Correlation-Id": "corr-1" } } });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["x-correlation-id"], "corr-1");
    assert.deepEqual(Object.keys(res.body).sort(), ["expiresIn", "token", "user"]);
    assert.deepEqual(res.body.user, { id: "42", username: "alice" });
    assert.equal(res.body.expiresIn, 600);

    const [tokenCall, userCall] = calls;
    assert.equal(tokenCall.init.method, "POST");
    const form = Object.fromEntries(tokenCall.init.body);
    assert.deepEqual(form, {
      client_id: "1562814087900037260",
      client_secret: SECRET,
      grant_type: "authorization_code",
      code: CODE,
      code_verifier: VERIFIER,
      redirect_uri: WEB_REDIRECT,
    });
    assert.equal(userCall.init.headers.Authorization, `Bearer ${ACCESS}`);

    const config = loadConfig(env());
    const { header, claims } = decodeAndVerify(res.body.token, jwks(config.signingKey));
    assert.equal(header.alg, "ES256");
    assert.equal(claims.iss, "urn:test:auth");
    assert.equal(claims.aud, "urn:test:api");
    assert.equal(claims.sub, "42");
    assert.equal(claims.username, "alice");
    assert.equal(claims.iat, NOW / 1000);
    assert.equal(claims.exp - claims.iat, 600);
    assert.match(claims.jti, /^[0-9a-f-]{36}$/);

    const entry = JSON.parse(lines.at(-1));
    assert.equal(entry.event_type, "auth.login.succeeded");
    assert.equal(entry.user_id, "42");
    assert.equal(entry.correlation_id, "corr-1");
    assertNoSecretInLogs(lines, res);
  });

  test("rejects an unknown redirect_uri before calling Discord", async () => {
    for (const redirectUri of ["https://evil.example/", "https://app.example.com", "https://app.example.com/?x=1", 42]) {
      const { res, calls, lines } = await run({ req: { body: webBody({ redirectUri }) } });
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, { error: "invalid_redirect_uri" });
      assert.equal(calls.length, 0);
      assertNoSecretInLogs(lines, res);
    }
  });

  test("requires a redirect_uri outside the Activity", async () => {
    const { res, calls } = await run({ req: { body: webBody({ redirectUri: undefined, activity: undefined }) } });
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  });
});

describe("POST Activity flow", () => {
  test("omits redirect_uri and returns discordAccessToken", async () => {
    const { res, calls, lines } = await run({ req: { body: activityBody() } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.discordAccessToken, ACCESS);
    assert.equal(res.body.refreshToken, undefined);
    const form = Object.fromEntries(calls[0].init.body);
    assert.equal(form.redirect_uri, undefined);
    assert.equal(form.code_verifier, VERIFIER);
    assertNoSecretInLogs(lines, res);
  });

  test("rejects a redirectUri in the Activity flow", async () => {
    const { res, calls } = await run({ req: { body: activityBody({ redirectUri: WEB_REDIRECT }) } });
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  });
});

describe("POST validation and upstream errors", () => {
  for (const [name, body] of [
    ["no body", undefined],
    ["array body", []],
    ["string body", "code=1"],
    ["missing code", webBody({ code: undefined })],
    ["code with spaces", webBody({ code: "a b" })],
    ["short verifier", webBody({ codeVerifier: "short" })],
    ["non boolean activity", webBody({ activity: "true" })],
  ]) {
    test(`400 on ${name}`, async () => {
      const { res, calls, lines } = await run({ req: { body } });
      assert.equal(res.statusCode, 400);
      assert.equal(calls.length, 0);
      assertNoSecretInLogs(lines, res);
    });
  }

  test("401 when Discord rejects the code", async () => {
    const routes = { ...discordOk(), "https://discord.com/api/v10/oauth2/token": () => json(400, { error: "invalid_grant", error_description: `bad ${CODE}` }) };
    const { res, lines } = await run({ routes, req: { body: webBody() } });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "invalid_grant" });
    assertNoSecretInLogs(lines, res);
  });

  test("502 when Discord fails or is unreachable", async () => {
    const cases = [
      { "https://discord.com/api/v10/oauth2/token": () => json(500, {}) },
      { "https://discord.com/api/v10/oauth2/token": () => json(429, {}) },
      {
        "https://discord.com/api/v10/oauth2/token": () => {
          throw new TypeError("fetch failed");
        },
      },
      { "https://discord.com/api/v10/users/@me": () => json(503, {}) },
      { "https://discord.com/api/v10/users/@me": () => json(200, { id: "not-a-snowflake", username: "x" }) },
    ];
    for (const override of cases) {
      const { res, lines } = await run({ routes: { ...discordOk(), ...override }, req: { body: webBody() } });
      assert.equal(res.statusCode, 502);
      assert.deepEqual(res.body, { error: "upstream_error" });
      assertNoSecretInLogs(lines, res);
    }
  });

  test("502 when the token lacks the identify scope", async () => {
    const { res } = await run({ routes: discordOk("email"), req: { body: webBody() } });
    assert.equal(res.statusCode, 502);
  });
});

describe("GET, OPTIONS and other methods", () => {
  test("GET serves the public key set only", async () => {
    const { res } = await run({ req: { method: "GET" } });
    assert.equal(res.statusCode, 200);
    const [key] = res.body.keys;
    assert.equal(key.kty, "EC");
    assert.equal(key.alg, "ES256");
    assert.equal(key.use, "sig");
    assert.equal(key.d, undefined, "no private member");
    assert.match(res.headers["cache-control"], /max-age=300/);
  });

  test("OPTIONS allows the origins of the redirect allow-list only", async () => {
    const ok = await run({ req: { method: "OPTIONS", headers: { Origin: "https://app.example.com" } } });
    assert.equal(ok.res.statusCode, 204);
    assert.equal(ok.res.headers["access-control-allow-origin"], "https://app.example.com");
    assert.match(ok.res.headers["access-control-allow-headers"], /X-Correlation-Id/);

    const ko = await run({ req: { method: "OPTIONS", headers: { Origin: "https://evil.example" } } });
    assert.equal(ko.res.headers["access-control-allow-origin"], undefined);
  });

  test("405 on other methods", async () => {
    const { res } = await run({ req: { method: "PUT" } });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, "POST, GET, OPTIONS");
  });

  test("replaces a malformed correlation id", async () => {
    const { res, lines } = await run({ req: { method: "POST", body: undefined, headers: { "X-Correlation-Id": "a\nb" } } });
    assert.match(res.headers["x-correlation-id"], /^[0-9a-f-]{36}$/);
    assert.equal(JSON.parse(lines[0]).correlation_id, res.headers["x-correlation-id"]);
  });
});

describe("Firebase custom token (FIREBASE_CUSTOM_TOKEN=true)", () => {
  const SA = "fn-auth-discord@proj.iam.gserviceaccount.com";
  const META = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default";
  const firebaseRoutes = (signJwt) => ({
    ...discordOk(),
    [`${META}/email`]: () => new Response(SA),
    [`${META}/token`]: () => json(200, { access_token: "gcp-access-token", expires_in: 3599 }),
    "https://iamcredentials.googleapis.com/": signJwt,
  });

  test("signs with the function's own account through IAM signJwt", async () => {
    let signed;
    const routes = firebaseRoutes((init) => {
      signed = JSON.parse(JSON.parse(init.body).payload);
      return json(200, { keyId: "k", signedJwt: "firebase.custom.token" });
    });
    const { res, calls, lines } = await run({ envOverrides: { FIREBASE_CUSTOM_TOKEN: "true" }, routes, req: { body: activityBody() } });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.firebaseToken, "firebase.custom.token");
    const signCall = calls.find((c) => c.url.startsWith("https://iamcredentials"));
    assert.equal(signCall.url, `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SA)}:signJwt`);
    assert.equal(signCall.init.headers.Authorization, "Bearer gcp-access-token");
    assert.equal(calls.find((c) => c.url.startsWith(META)).init.headers["Metadata-Flavor"], "Google");
    assert.deepEqual(signed, {
      iss: SA,
      sub: SA,
      aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
      iat: NOW / 1000,
      exp: NOW / 1000 + 600,
      uid: "42",
    });
    assert.ok(!lines.join("\n").includes("gcp-access-token"));
  });

  test("502 when signJwt is denied (missing token creator role)", async () => {
    const { res, lines } = await run({
      envOverrides: { FIREBASE_CUSTOM_TOKEN: "true" },
      routes: firebaseRoutes(() => json(403, { error: { message: "denied" } })),
      req: { body: webBody() },
    });
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(lines.at(-1)).reason, "sign_jwt_http_error");
    assertNoSecretInLogs(lines, res);
  });

  test("disabled by default: no Google call, no firebaseToken", async () => {
    const { res, calls } = await run({ req: { body: webBody() } });
    assert.equal(res.body.firebaseToken, undefined);
    assert.ok(calls.every((c) => c.url.startsWith("https://discord.com/")));
  });
});

describe("configuration", () => {
  test("redirect allow-list accepts https and http://localhost only, without fragment", () => {
    assert.equal(parseRedirectUris(JSON.stringify(["https://a.example/", "http://localhost:5173/"])).size, 2);
    for (const bad of [["http://a.example/"], ["https://a.example/#x"], ["not a url"], "https://a.example/"]) {
      assert.throws(() => parseRedirectUris(JSON.stringify(bad)));
    }
    assert.equal(parseRedirectUris(undefined).size, 0);
  });

  test("fails on a missing secret or a weak key", () => {
    assert.throws(() => loadConfig(env({ DISCORD_CLIENT_SECRET: "" })), /missing DISCORD_CLIENT_SECRET/);
    assert.throws(() => loadConfig(env({ JWT_SIGNING_KEY: pem("ec", { namedCurve: "secp256k1" }) })), /P-256 or RSA/);
    assert.throws(() => loadConfig(env({ JWT_SIGNING_KEY: pem("rsa", { modulusLength: 1024 }) })), /P-256 or RSA/);
    assert.throws(() => loadConfig(env({ JWT_TTL_SECONDS: "86400" })), /JWT_TTL_SECONDS/);
  });

  test("nothing has a default in the code: each setting must come from the environment", () => {
    for (const name of ["JWT_TTL_SECONDS", "FUNCTION_NAME", "DISCORD_API_URL", "HTTP_TIMEOUT_MS"]) {
      assert.throws(() => loadConfig(env({ [name]: "" })), new RegExp(`missing ${name}`));
    }
    assert.throws(() => loadConfig(env({ DISCORD_API_URL: "not a url" })), /DISCORD_API_URL must be a URL/);
    // Google endpoints are only required when the Firebase custom token is on.
    for (const name of ["GCE_METADATA_URL", "IAM_CREDENTIALS_URL", "FIREBASE_TOKEN_AUDIENCE"]) {
      assert.doesNotThrow(() => loadConfig(env({ [name]: "" })));
      assert.throws(() => loadConfig(env({ FIREBASE_CUSTOM_TOKEN: "true", [name]: "" })), new RegExp(`missing ${name}`));
    }
  });

  test("an RSA key signs RS256 and verifies against its JWKS", () => {
    const key = loadSigningKey(pem("rsa", { modulusLength: 2048 }));
    const { header, claims } = decodeAndVerify(signJwt(key, { sub: "42" }), jwks(key));
    assert.equal(header.alg, "RS256");
    assert.equal(claims.sub, "42");
  });

  test("the entry point answers 500 without leaking anything when misconfigured", async (t) => {
    const writes = [];
    t.mock.method(process.stdout, "write", (chunk) => (writes.push(String(chunk)), true));
    const res = fakeRes();
    await authDiscord(fakeReq({ body: webBody() }), res);
    t.mock.restoreAll();
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: "server_error" });
    assert.equal(JSON.parse(writes[0]).event_type, "auth.config.invalid");
  });
});
