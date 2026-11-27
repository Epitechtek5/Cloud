// /get composed from the tile rasters (#68): the region reader replaces
// `store.readRegion` of the command worker, `commands.js` is untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleCommand } from "../../src/commands/commands.js";
import { createTileBucket } from "../../src/tiles/bucket.js";
import { createRasterRegionReader, regionPixels } from "../../src/tiles/region.js";
import { applyPixels, emptyRaster } from "../../src/tiles/raster.js";
import { renderTile } from "../../src/tiles/renderer.js";
import { decodePng } from "../lib/pngDecode.js";
import { command, config, fakePublisher, fakeStore } from "../commands/helpers.js";
import { fakePixels, fakeStorageBucket } from "./helpers.js";

function setup(pixels = [], clearedAt = 0) {
  const storage = fakeStorageBucket();
  const bucket = createTileBucket(storage);
  const px = fakePixels(pixels);
  const store = { ...fakeStore({ session: { paused: false, clearedAt } }), readRegion: createRasterRegionReader({ bucket, readPixels: px.read }) };
  const { publisher } = fakePublisher();
  const get = (options) => handleCommand(command("get", { options }), { store, publisher, config, correlationId: "corr-12345678" });
  return { storage, bucket, px, store, get };
}

/** Colour of the grid pixel (x, y) in a /get image whose region starts at (x0, y0), drawn at `scale`. */
function colourAt(png, x0, y0, scale, x, y) {
  const i = (((y - y0) * scale) * png.width + (x - x0) * scale) * 4;
  return [...png.rgba.subarray(i, i + 4)];
}

test("/get returns a PNG attachment of the region, from a raster plus the pixels newer than it", async () => {
  const w = setup([{ x: 100, y: 200, c: 0x0000ff, t: 1000 }]);
  await renderTile({ bucket: w.bucket, readSession: async () => ({ clearedAt: 0 }), readPixels: w.px.read }, 0, 0);
  // Painted after the raster was rendered: still in the image.
  w.px.paint({ x: 101, y: 200, c: 0xff0000, t: 2000 });
  w.px.queries.length = 0;

  const { reply } = await w.get({ x: 108, y: 208, size: 16 });
  const [file] = reply.files;
  assert.equal(file.contentType, "image/png");
  const png = decodePng(file.data);
  assert.equal(png.width, 512);
  assert.deepEqual(colourAt(png, 100, 200, 32, 100, 200), [0, 0, 255, 255], "from the raster");
  assert.deepEqual(colourAt(png, 100, 200, 32, 101, 200), [255, 0, 0, 255], "from the new pixel");
  assert.deepEqual(colourAt(png, 100, 200, 32, 102, 200), [255, 255, 255, 255], "unpainted: background");
  assert.match(reply.content, /2 painted pixel/);
  assert.deepEqual(w.px.queries, [{ tx: 0, ty: 0, sinceMs: 1000, clearedAt: 0 }], "only the pixels newer than the raster were read");
});

test("a 512 region that is not aligned on the tiles reads its 9 tiles, each once, and no more", async () => {
  const w = setup([
    { x: 200, y: 200, c: 0x010101, t: 10 }, // tile 0_0 (inside the region)
    { x: 700, y: 200, c: 0x020202, t: 10 }, // tile 2_0
    { x: 200, y: 700, c: 0x030303, t: 10 }, // tile 0_2
    { x: 600, y: 600, c: 0x040404, t: 10 }, // tile 2_2
    { x: 100, y: 100, c: 0x050505, t: 10 }, // tile 0_0 but outside the region
  ]);
  const { reply } = await w.get({ x: 456, y: 456, size: 512 });
  const touched = new Set(w.px.queries.map((q) => `${q.tx}_${q.ty}`));
  assert.equal(w.px.queries.length, 9);
  assert.equal(touched.size, 9);
  assert.match(reply.content, /\(200, 200\) to \(711, 711\), 4 painted pixel/);
  const png = decodePng(reply.files[0].data);
  assert.equal(png.width, 512, "scale 1 at 512");
  assert.deepEqual(colourAt(png, 200, 200, 1, 200, 200), [1, 1, 1, 255]);
  assert.deepEqual(colourAt(png, 200, 200, 1, 700, 200), [2, 2, 2, 255]);
  assert.deepEqual(colourAt(png, 200, 200, 1, 200, 700), [3, 3, 3, 255]);
  assert.deepEqual(colourAt(png, 200, 200, 1, 600, 600), [4, 4, 4, 255]);
});

test("/get never shows a pixel from before the last clear, raster or not", async () => {
  const w = setup([{ x: 100, y: 200, c: 0x0000ff, t: 1000 }, { x: 102, y: 200, c: 0x00ff00, t: 5000 }], 3000);
  // A raster rendered before the clear that the sweep has not removed yet.
  const rgba = emptyRaster();
  applyPixels(rgba, [{ x: 100, y: 200, c: 0x0000ff }, { x: 101, y: 200, c: 0xff00ff }]);
  await w.bucket.write(0, 0, rgba, 2000);

  const { reply } = await w.get({ x: 108, y: 208, size: 16 });
  const png = decodePng(reply.files[0].data);
  assert.deepEqual(colourAt(png, 100, 200, 32, 100, 200), [255, 255, 255, 255]);
  assert.deepEqual(colourAt(png, 100, 200, 32, 101, 200), [255, 255, 255, 255]);
  assert.deepEqual(colourAt(png, 100, 200, 32, 102, 200), [0, 255, 0, 255]);
  assert.match(reply.content, /1 painted pixel/);
});

test("an empty canvas still gives an image", async () => {
  const w = setup();
  const { reply } = await w.get({});
  assert.match(reply.content, /0 painted pixel/);
  assert.equal(reply.files[0].name, "canvas.png");
  assert.equal(w.storage.calls.save, 0, "/get never writes a raster");
});

test("regionPixels clips a tile to the region, in grid coordinates", () => {
  const rgba = emptyRaster();
  applyPixels(rgba, [{ x: 256, y: 0, c: 1 }, { x: 300, y: 5, c: 2 }, { x: 511, y: 255, c: 3 }]);
  assert.deepEqual(regionPixels(rgba, 1, 0, { x0: 290, y0: 0, size: 300 }), [{ x: 300, y: 5, c: 2 }, { x: 511, y: 255, c: 3 }]);
  assert.deepEqual(regionPixels(rgba, 1, 0, { x0: 0, y0: 100, size: 50 }), []);
});
