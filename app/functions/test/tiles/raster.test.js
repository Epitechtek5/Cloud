import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { crc32, encodePng } from "../../src/lib/png.js";
import { decodePng, PngError, readPngText } from "../../src/lib/pngDecode.js";
import {
  applyPixels,
  colorAt,
  decodeRaster,
  emptyRaster,
  encodeRaster,
  inTileGrid,
  isBlank,
  parseTile,
  pixelOffset,
  rasterVersion,
  tileId,
  tileName,
  tilesOfPixels,
} from "../../src/tiles/raster.js";

// --- tile and offset arithmetic ----------------------------------------------

test("a pixel belongs to the tile floor(x / 256), floor(y / 256) and sits at its offset in it", () => {
  assert.equal(pixelOffset(0, 0), 0);
  assert.equal(pixelOffset(255, 0), 255 * 4);
  assert.equal(pixelOffset(256, 0), 0, "first pixel of the next tile");
  assert.equal(pixelOffset(257, 3), (3 * 256 + 1) * 4);
  assert.equal(pixelOffset(0, 255), 255 * 256 * 4);
  // 99999 = 390 * 256 + 159: the last, partial tile of the grid.
  assert.equal(pixelOffset(99999, 99999), (159 * 256 + 159) * 4);
  assert.deepEqual(tilesOfPixels([{ x: 99999, y: 99999 }]), ["390_390"]);
});

test("tilesOfPixels lists each touched tile once", () => {
  const tiles = tilesOfPixels([
    { x: 1, y: 1 },
    { x: 255, y: 255 },
    { x: 256, y: 0 },
    { x: 300, y: 10 },
    { x: 0, y: 256 },
  ]);
  assert.deepEqual(tiles.sort(), ["0_0", "0_1", "1_0"]);
  assert.deepEqual(tilesOfPixels([]), []);
});

test("tile names and ids", () => {
  assert.equal(tileName(3, 17), "tiles/3/17.png");
  assert.equal(tileId(3, 17), "3_17");
  assert.deepEqual(parseTile("3_17"), { tx: 3, ty: 17 });
  assert.equal(inTileGrid(0, 0), true);
  assert.equal(inTileGrid(390, 390), true);
  assert.equal(inTileGrid(391, 0), false, "391 tiles per side: 0..390");
  assert.equal(inTileGrid(-1, 0), false);
  assert.equal(inTileGrid(1.5, 0), false);
});

// --- raster ------------------------------------------------------------------

test("a raster starts transparent and painting sets colour and full alpha, the last pixel wins", () => {
  const rgba = emptyRaster();
  assert.equal(rgba.length, 256 * 256 * 4);
  assert.equal(isBlank(rgba), true);

  applyPixels(rgba, [
    { x: 256 + 5, y: 7, c: 0x112233 },
    { x: 256 + 5, y: 7, c: 0xaabbcc },
  ]);
  const i = pixelOffset(261, 7);
  assert.deepEqual([...rgba.subarray(i, i + 4)], [0xaa, 0xbb, 0xcc, 0xff]);
  assert.equal(colorAt(rgba, i), 0xaabbcc);
  assert.equal(colorAt(rgba, 0), -1, "unpainted pixels read as transparent");
  assert.equal(isBlank(rgba), false);
  // Black is painted, not transparent.
  applyPixels(rgba, [{ x: 0, y: 0, c: 0 }]);
  assert.equal(colorAt(rgba, 0), 0);
});

test("a raster survives encode then decode with its version", () => {
  const rgba = emptyRaster();
  applyPixels(rgba, [{ x: 10, y: 20, c: 0xff0000 }]);
  const png = encodeRaster(rgba, 1_700_000_000_123);
  assert.equal(rasterVersion(png), 1_700_000_000_123);
  const back = decodeRaster(png);
  assert.equal(back.version, 1_700_000_000_123);
  assert.deepEqual(Buffer.from(back.rgba), Buffer.from(rgba));
});

test("a raster without a valid version, or of the wrong size, is refused", () => {
  const noVersion = encodePng(256, 256, emptyRaster());
  assert.throws(() => rasterVersion(noVersion), PngError);
  assert.throws(() => decodeRaster(noVersion), PngError);
  const bad = encodePng(256, 256, emptyRaster(), { text: { "Tile-Version": "12ms" } });
  assert.throws(() => rasterVersion(bad), /version/);
  const small = encodePng(16, 16, new Uint8Array(16 * 16 * 4), { text: { "Tile-Version": "1" } });
  assert.throws(() => decodeRaster(small), /wrong size/);
});

// --- PNG decoder -------------------------------------------------------------

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A PNG with the given colour type and scanlines `[filter, ...bytes]`. */
function pngOf({ width, height, colorType = 6, depth = 8, interlace = 0, scanlines }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = colorType;
  header[12] = interlace;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from(scanlines.flat()))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("the decoder reads back what encodePng writes, with its text chunks", () => {
  const rgba = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 0]);
  const png = encodePng(2, 1, rgba, { text: { Title: "hello", Other: "x" } });
  const image = decodePng(png);
  assert.deepEqual([image.width, image.height], [2, 1]);
  assert.deepEqual([...image.rgba], [...rgba]);
  assert.deepEqual(image.text, { Title: "hello", Other: "x" });
  assert.deepEqual(readPngText(png), { Title: "hello", Other: "x" });
});

test("the decoder undoes the Sub, Up, Average and Paeth filters", () => {
  // Two rows of two RGBA pixels; each filter type applied to a known image.
  // Expected image: row0 = 10 20 30 255 | 40 50 60 255, row1 = 11 21 31 255 | 41 51 61 255
  const row0 = [10, 20, 30, 255, 40, 50, 60, 255];
  const row1 = [11, 21, 31, 255, 41, 51, 61, 255];
  const expected = [...row0, ...row1];

  const sub = (row) => row.map((v, i) => (v - (i >= 4 ? row[i - 4] : 0)) & 0xff);
  const up = (row, prev) => row.map((v, i) => (v - prev[i]) & 0xff);
  const average = (row, prev) => row.map((v, i) => (v - ((i >= 4 ? row[i - 4] : 0) + prev[i] >> 1)) & 0xff);
  const paeth = (row, prev) =>
    row.map((v, i) => {
      const a = i >= 4 ? row[i - 4] : 0;
      const b = prev[i];
      const c = i >= 4 ? prev[i - 4] : 0;
      const p = a + b - c;
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      return (v - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
    });

  const cases = [
    [[1, ...sub(row0)], [1, ...sub(row1)]],
    [[0, ...row0], [2, ...up(row1, row0)]],
    [[3, ...average(row0, new Array(8).fill(0))], [3, ...average(row1, row0)]],
    [[4, ...paeth(row0, new Array(8).fill(0))], [4, ...paeth(row1, row0)]],
  ];
  for (const scanlines of cases) {
    const image = decodePng(pngOf({ width: 2, height: 2, scanlines }));
    assert.deepEqual([...image.rgba], expected, `filter ${scanlines[1][0]}`);
  }
});

test("the decoder expands RGB to opaque RGBA", () => {
  const image = decodePng(pngOf({ width: 2, height: 1, colorType: 2, scanlines: [[0, 1, 2, 3, 4, 5, 6]] }));
  assert.deepEqual([...image.rgba], [1, 2, 3, 255, 4, 5, 6, 255]);
});

test("the decoder refuses what is not a plain 8-bit RGB(A) PNG, or is damaged", () => {
  const good = encodePng(2, 2, new Uint8Array(16));
  assert.throws(() => decodePng(Buffer.from("not a png")), /not a PNG/);
  assert.throws(() => decodePng(good.subarray(0, good.length - 6)), /truncated|CRC/);
  const corrupt = Buffer.from(good);
  corrupt[corrupt.length - 20] ^= 0xff;
  assert.throws(() => decodePng(corrupt), PngError);
  assert.throws(() => decodePng(pngOf({ width: 1, height: 1, depth: 16, scanlines: [[0, 0, 0, 0, 0]] })), /unsupported/);
  assert.throws(() => decodePng(pngOf({ width: 1, height: 1, colorType: 3, scanlines: [[0, 0]] })), /unsupported/);
  assert.throws(() => decodePng(pngOf({ width: 1, height: 1, interlace: 1, scanlines: [[0, 0, 0, 0, 0]] })), /unsupported/);
  assert.throws(() => decodePng(pngOf({ width: 1, height: 1, scanlines: [[9, 0, 0, 0, 0]] })), /unknown filter/);
  assert.throws(() => decodePng(pngOf({ width: 1, height: 1, scanlines: [[0, 0]] })), /inflate|length/);
  assert.throws(() => decodePng(good, { maxPixels: 3 }), /size/);
  const noHeader = Buffer.concat([good.subarray(0, 8), chunk("IEND", Buffer.alloc(0))]);
  assert.throws(() => decodePng(noHeader), /IHDR/);
});

test("a decompression bomb is cut at the size the header announces", () => {
  const bomb = pngOf({ width: 1, height: 1, scanlines: [new Array(1_000_000).fill(0)] });
  assert.throws(() => decodePng(bomb), PngError);
});
