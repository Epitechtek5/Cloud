// Test helper: reads back the PNGs written by src/lib/png.js.
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { crc32 } from "../../src/lib/png.js";

/** Splits a PNG into its chunks, checking each CRC. */
export function readChunks(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    assert.equal(png.readUInt32BE(offset + 8 + length), crc32(png.subarray(offset + 4, offset + 8 + length)), `CRC of ${type}`);
    chunks.push({ type, data });
    offset += 12 + length;
  }
  return chunks;
}

/** Decodes the RGBA pixels of a PNG written by encodePng (filter 0 only). */
export function decodePng(png) {
  const chunks = readChunks(png);
  const ihdr = chunks.find((c) => c.type === "IHDR").data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)));
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width * 4 + 1)], 0, "filter type none");
    raw.copy(rgba, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  }
  return { width, height, rgba, chunks };
}
