import { test } from "node:test";
import assert from "node:assert/strict";
import { hello } from "../src/index.js";

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
