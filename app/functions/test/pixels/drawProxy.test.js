import { test } from "node:test";
import assert from "node:assert/strict";
import { createDrawProxy } from "../../src/pixels/drawProxy.js";
import { gatewayUser, parseOrigins } from "../../src/pixels/http.js";
import { createLogger } from "../../src/lib/logger.js";
import { captureLogs } from "../lib/helpers.js";
import { fakePublisher } from "../commands/helpers.js";
import { apiRequest, apiResponse, USER, userinfo } from "./helpers.js";

const ORIGIN = "https://app.test";
const batch = { batchId: "3f1c2b8e-1d2a-4f5b-9c0d-112233445566", pixels: [{ x: 10, y: 20, color: 0xff0000 }] };

function setup({ publishFail } = {}) {
  const out = captureLogs();
  const { publisher, published } = fakePublisher({ fail: publishFail });
  const proxy = createDrawProxy({ publisher, origins: new Set([ORIGIN]), logger: createLogger({}, { write: out.write }) });
  const call = async (req) => {
    const res = apiResponse();
    await proxy(req, res);
    return res;
  };
  return { call, published, logs: out.lines };
}

test("publishes one pixel.draw for the authenticated user and answers 202 without waiting", async () => {
  const { call, published } = setup();
  const res = await call(apiRequest({ body: batch, headers: { "X-Correlation-Id": "corr-from-front", Origin: ORIGIN } }));
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { batchId: batch.batchId });
  assert.equal(res.headers["X-Correlation-Id"], "corr-from-front");
  assert.equal(res.headers["Access-Control-Allow-Origin"], ORIGIN);
  assert.equal(published.length, 1);
  assert.equal(published[0].topic, "pixel.draw");
  assert.deepEqual(published[0].payload, { batchId: batch.batchId, user: USER, source: "web", pixels: batch.pixels });
  assert.equal(published[0].attributes.correlation_id, "corr-from-front");
});

test("401 without the gateway's user (missing, garbled or without a Discord id)", async () => {
  const { call, published } = setup();
  for (const headers of [{}, { "X-Apigateway-Api-Userinfo": "%%%" }, { "X-Apigateway-Api-Userinfo": userinfo({ sub: "bob" }) }, { "X-Apigateway-Api-Userinfo": "" }]) {
    const res = await call(apiRequest({ body: batch, user: false, headers }));
    assert.equal(res.statusCode, 401);
  }
  assert.equal(published.length, 0);
});

test("400 on an invalid payload, with the paths only", async () => {
  const { call, published } = setup();
  const cases = [
    undefined,
    [],
    { pixels: batch.pixels },
    { batchId: "bad id", pixels: batch.pixels },
    { batchId: "b", pixels: [] },
    { batchId: "b", pixels: Array.from({ length: 257 }, (_, i) => ({ x: i, y: 0, color: 0 })) },
    { batchId: "b", pixels: [{ x: 100000, y: 0, color: 0 }] },
    { batchId: "b", pixels: [{ x: 0, y: -1, color: 0 }] },
    { batchId: "b", pixels: [{ x: 0, y: 0, color: 0x1000000 }] },
    { batchId: "b", pixels: [{ x: 0.5, y: 0, color: 0 }] },
    { batchId: "b", pixels: [{ x: 0, y: 0, color: 0, extra: 1 }] },
    { ...batch, user: { id: "999999999" } },
  ];
  for (const body of cases) {
    const res = await call(apiRequest({ body }));
    assert.equal(res.statusCode, 400, JSON.stringify(body)?.slice(0, 80));
    assert.equal(res.body.error, "invalid_request");
    assert.ok(res.body.details.length > 0);
  }
  const res = await call(apiRequest({ body: { batchId: "b", pixels: [{ x: 123456, y: 0, color: 0 }] } }));
  assert.ok(!JSON.stringify(res.body).includes("123456"));
  assert.equal(published.length, 0);
});

test("the user can never be chosen by the client", async () => {
  const { call, published } = setup();
  await call(apiRequest({ body: { ...batch, source: "discord" } }));
  assert.equal(published.length, 0);
});

test("CORS preflight is answered for known origins only; other methods get 405", async () => {
  const { call } = setup();
  const pre = await call(apiRequest({ method: "OPTIONS", user: false, headers: { Origin: ORIGIN } }));
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers["Access-Control-Allow-Methods"], "POST");
  assert.match(pre.headers["Access-Control-Allow-Headers"], /Authorization/);
  const foreign = await call(apiRequest({ method: "OPTIONS", headers: { Origin: "https://evil.test" } }));
  assert.equal(foreign.headers["Access-Control-Allow-Origin"], undefined);
  assert.equal((await call(apiRequest({ method: "GET" }))).statusCode, 405);
});

test("503 when the broker is unavailable", async () => {
  const { call, logs } = setup({ publishFail: new Error("pubsub down") });
  const res = await call(apiRequest({ body: batch }));
  assert.equal(res.statusCode, 503);
  assert.equal(logs.at(-1).severity, "ERROR");
});

test("gatewayUser and parseOrigins", () => {
  assert.deepEqual(gatewayUser(apiRequest()), USER);
  assert.deepEqual(gatewayUser(apiRequest({ user: false, headers: { "X-Apigateway-Api-Userinfo": userinfo({ sub: USER.id }) } })), { id: USER.id });
  assert.equal(gatewayUser({ headers: {} }), null);
  assert.deepEqual([...parseOrigins('["https://a.test/", "http://localhost:5173/x"]')], ["https://a.test", "http://localhost:5173"]);
  assert.equal(parseOrigins(undefined).size, 0);
  assert.throws(() => parseOrigins('{"a":1}'), /JSON array/);
});
