import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHandler, authDiscord } from "../src/auth-discord/handler.js";
import { loadConfig, parseRedirectUris } from "../src/auth-discord/config.js";

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
    JWT_ISSUER: "urn:test:auth",
    JWT_AUDIENCE: "urn:test:api",
    JWT_TTL_SECONDS: "600",
    FUNCTION_NAME: "auth-discord",
    HTTP_TIMEOUT_MS: "5000",
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

const SA = "fn-auth-discord@proj.iam.gserviceaccount.com";
const META = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default";

/** The metadata server and IAM Credentials; `signJwt` receives the request init. */
const iamRoutes = (signJwt) => ({
  [`${META}/email`]: () => new Response(SA),
  [`${META}/token`]: () => json(200, { access_token: "gcp-access-token", expires_in: 3599 }),
  "https://iamcredentials.googleapis.com/": signJwt,
});

/** Fake signer: returns the claims it was asked to sign, so tests can read them back. */
const signedClaims = (init) => json(200, { keyId: "k", signedJwt: `h.${Buffer.from(JSON.parse(init.body).payload).toString("base64url")}.s` });
const claimsOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url"));

const discordOk = (scope = "identify") => ({
  ...iamRoutes(signedClaims),
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

    // The gateway checks iss, aud and exp; the signature is Google's (signJwt).
    const claims = claimsOf(res.body.token);
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

describe("OPTIONS and other methods", () => {
  test("OPTIONS allows the origins of the redirect allow-list only", async () => {
    const ok = await run({ req: { method: "OPTIONS", headers: { Origin: "https://app.example.com" } } });
    assert.equal(ok.res.statusCode, 204);
    assert.equal(ok.res.headers["access-control-allow-origin"], "https://app.example.com");
    assert.match(ok.res.headers["access-control-allow-headers"], /X-Correlation-Id/);

    const ko = await run({ req: { method: "OPTIONS", headers: { Origin: "https://evil.example" } } });
    assert.equal(ko.res.headers["access-control-allow-origin"], undefined);
  });

  test("405 on other methods, GET included (no key set is served any more)", async () => {
    for (const method of ["PUT", "GET"]) {
      const { res, calls } = await run({ req: { method } });
      assert.equal(res.statusCode, 405);
      assert.equal(res.headers.allow, "POST, OPTIONS");
      assert.equal(calls.length, 0);
    }
  });

  test("replaces a malformed correlation id", async () => {
    const { res, lines } = await run({ req: { method: "POST", body: undefined, headers: { "X-Correlation-Id": "a\nb" } } });
    assert.match(res.headers["x-correlation-id"], /^[0-9a-f-]{36}$/);
    assert.equal(JSON.parse(lines[0]).correlation_id, res.headers["x-correlation-id"]);
  });
});

describe("session JWT signed by the function's own account", () => {
  test("goes through IAM signJwt with the account found in the metadata server", async () => {
    let payload;
    const routes = { ...discordOk(), "https://iamcredentials.googleapis.com/": (init) => ((payload = JSON.parse(init.body).payload), signedClaims(init)) };
    const { res, calls, lines } = await run({ routes, req: { body: webBody() } });

    assert.equal(res.statusCode, 200);
    const signCall = calls.find((c) => c.url.startsWith("https://iamcredentials"));
    assert.equal(signCall.url, `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SA)}:signJwt`);
    assert.equal(signCall.init.method, "POST");
    assert.equal(signCall.init.headers.Authorization, "Bearer gcp-access-token");
    assert.equal(calls.find((c) => c.url.startsWith(META)).init.headers["Metadata-Flavor"], "Google");
    // What the gateway checks: x-google-issuer, x-google-audiences, exp; sub is the Discord id.
    assert.deepEqual(Object.keys(JSON.parse(payload)).sort(), ["aud", "exp", "iat", "iss", "jti", "sub", "username"]);
    assert.ok(!lines.join("\n").includes("gcp-access-token"));
    assertNoSecretInLogs(lines, res);
  });

  test("reads the account and the access token once per instance", async () => {
    const fetch = fakeFetch(discordOk());
    const handler = createHandler({ config: loadConfig(env()), fetch, now: () => NOW, write: () => {} });
    for (let i = 0; i < 3; i++) await handler(fakeReq({ body: webBody() }), fakeRes());
    const count = (prefix) => fetch.calls.filter((c) => c.url.startsWith(prefix)).length;
    assert.equal(count(`${META}/email`), 1);
    assert.equal(count(`${META}/token`), 1);
    assert.equal(count("https://iamcredentials"), 3);
  });

  test("502 when signJwt is denied (missing token creator role): no token is issued", async () => {
    const routes = { ...discordOk(), "https://iamcredentials.googleapis.com/": () => json(403, { error: { message: "denied" } }) };
    const { res, lines } = await run({ routes, req: { body: webBody() } });
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.body, { error: "upstream_error" });
    assert.equal(JSON.parse(lines.at(-1)).reason, "sign_jwt_http_error");
    assertNoSecretInLogs(lines, res);
  });

  test("502 when the metadata server is unreachable or answers nonsense", async () => {
    for (const override of [
      { [`${META}/email`]: () => { throw new TypeError("fetch failed"); } },
      { [`${META}/token`]: () => json(200, { nope: true }) },
      { "https://iamcredentials.googleapis.com/": () => json(200, { keyId: "k" }) },
    ]) {
      const { res, lines } = await run({ routes: { ...discordOk(), ...override }, req: { body: webBody() } });
      assert.equal(res.statusCode, 502);
      assertNoSecretInLogs(lines, res);
    }
  });
});

describe("Firebase custom token (FIREBASE_CUSTOM_TOKEN=true)", () => {
  test("is signed the same way, with the account as issuer and the Discord id as uid", async () => {
    const signed = [];
    const routes = {
      ...discordOk(),
      "https://iamcredentials.googleapis.com/": (init) => (signed.push(JSON.parse(JSON.parse(init.body).payload)), json(200, { keyId: "k", signedJwt: `jwt.${signed.length}.sig` })),
    };
    const { res, lines } = await run({ envOverrides: { FIREBASE_CUSTOM_TOKEN: "true" }, routes, req: { body: activityBody() } });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.token, "jwt.1.sig");
    assert.equal(res.body.firebaseToken, "jwt.2.sig");
    assert.deepEqual(signed[1], {
      iss: SA,
      sub: SA,
      aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
      iat: NOW / 1000,
      exp: NOW / 1000 + 600,
      uid: "42",
    });
    assert.ok(!lines.join("\n").includes("gcp-access-token"));
  });

  test("disabled by default: a single signature, no firebaseToken", async () => {
    const { res, calls } = await run({ req: { body: webBody() } });
    assert.equal(res.body.firebaseToken, undefined);
    assert.equal(calls.filter((c) => c.url.startsWith("https://iamcredentials")).length, 1);
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

  test("fails on a missing secret or an out-of-range TTL", () => {
    assert.throws(() => loadConfig(env({ DISCORD_CLIENT_SECRET: "" })), /missing DISCORD_CLIENT_SECRET/);
    assert.throws(() => loadConfig(env({ JWT_TTL_SECONDS: "86400" })), /JWT_TTL_SECONDS/);
  });

  test("needs no signing key: the account of the function signs", () => {
    const config = loadConfig(env());
    assert.equal(config.signingKey, undefined);
  });

  test("the TTL, the timeout and the function name have no default in the code", () => {
    for (const name of ["JWT_TTL_SECONDS", "FUNCTION_NAME", "HTTP_TIMEOUT_MS"]) {
      assert.throws(() => loadConfig(env({ [name]: "" })), new RegExp(`missing ${name}`));
    }
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
