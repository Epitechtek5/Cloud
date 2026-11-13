import { test } from "node:test";
import assert from "node:assert/strict";
import { PALETTE, parseColor } from "../../src/lib/colors.js";

test("parses hex colours with or without #", () => {
  assert.equal(parseColor("#FF0000"), 0xff0000);
  assert.equal(parseColor("00ff7f"), 0x00ff7f);
  assert.equal(parseColor(" #000000 "), 0);
});

test("parses palette names", () => {
  assert.equal(parseColor("Red"), 0xe50000);
  assert.equal(Object.keys(PALETTE).length, 16);
  for (const [name, value] of Object.entries(PALETTE)) assert.equal(parseColor(name), value);
});

test("rejects anything else", () => {
  for (const value of ["#fff", "#gggggg", "toString", "", undefined, 0xff0000, "#ff00001"]) assert.equal(parseColor(value), null, String(value));
});
