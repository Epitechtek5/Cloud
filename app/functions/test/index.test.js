import { test } from "node:test";
import assert from "node:assert/strict";
import { discordProxy, hello, notImplemented } from "../src/index.js";

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
