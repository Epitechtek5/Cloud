import { test } from "node:test";
import assert from "node:assert/strict";
import { commandWorker, discordProxy, drawWorker, hello, notImplemented } from "../src/index.js";

test("hello answers 200", () => {
  let status;
  let body;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    send(text) {
      body = text;
    },
  };
  hello({}, res);
  assert.equal(status, 200);
  assert.equal(body, "ok");
});

test("exports the Discord proxy entry point", () => {
  assert.equal(typeof discordProxy, "function");
});

test("notImplemented answers 501 and is never cached", () => {
  const res = { headers: {} };
  res.set = (k, v) => ((res.headers[k] = v), res);
  res.status = (code) => ((res.status_ = code), res);
  res.json = (body) => ((res.body = body), res);
  notImplemented({}, res);
  assert.equal(res.status_, 501);
  assert.deepEqual(res.body, { error: "not_implemented" });
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("exports the command worker, which only accepts Pub/Sub pushes (POST)", async () => {
  const res = { headers: {} };
  res.set = (k, v) => ((res.headers[k] = v), res);
  res.status = (code) => ((res.status_ = code), res);
  res.send = (body) => ((res.body = body), res);
  await commandWorker({ method: "GET", headers: {} }, res);
  assert.equal(res.status_, 405);
  assert.equal(res.headers.Allow, "POST");
});

test("exports the draw worker, which only accepts Pub/Sub pushes (POST)", async () => {
  const res = { headers: {} };
  res.set = (k, v) => ((res.headers[k] = v), res);
  res.status = (code) => ((res.status_ = code), res);
  res.send = (body) => ((res.body = body), res);
  await drawWorker({ method: "PUT", headers: {} }, res);
  assert.equal(res.status_, 405);
});
