import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, encodePng } from "../../src/lib/png.js";
import { decodePng } from "./pngDecode.js";

test("crc32 matches the reference value", () => {
  assert.equal(crc32(Buffer.from("IEND")), 0xae426082);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("encodes RGBA pixels that decode back identically", () => {
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 1, 2, 3, 0, 10, 20, 30, 40, 50, 60, 70, 80]);
  const png = encodePng(3, 2, rgba, { text: { Title: "test" } });
  const decoded = decodePng(png);
  assert.equal(decoded.width, 3);
  assert.equal(decoded.height, 2);
  assert.deepEqual([...decoded.rgba], [...rgba]);
  const ihdr = decoded.chunks[0];
  assert.equal(ihdr.type, "IHDR");
  assert.equal(ihdr.data[8], 8);
  assert.equal(ihdr.data[9], 6);
  assert.equal(decoded.chunks.find((c) => c.type === "tEXt").data.toString("latin1"), "Title\0test");
  assert.equal(decoded.chunks.at(-1).type, "IEND");
});

test("refuses bad dimensions or a buffer of the wrong size", () => {
  assert.throws(() => encodePng(0, 1, new Uint8Array(0)), RangeError);
  assert.throws(() => encodePng(1.5, 1, new Uint8Array(4)), RangeError);
  assert.throws(() => encodePng(2, 2, new Uint8Array(4)), RangeError);
});
