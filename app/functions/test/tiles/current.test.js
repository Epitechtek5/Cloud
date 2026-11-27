import { test } from "node:test";
import assert from "node:assert/strict";
import { createTileBucket } from "../../src/tiles/bucket.js";
import { currentTile } from "../../src/tiles/current.js";
import { applyPixels, colorAt, emptyRaster, pixelOffset } from "../../src/tiles/raster.js";
import { fakePixels, fakeStorageBucket } from "./helpers.js";

const setup = (pixels = []) => ({ bucket: createTileBucket(fakeStorageBucket()), pixels: fakePixels(pixels) });
const run = ({ bucket, pixels }, clearedAt = 0, tx = 0, ty = 0) => currentTile({ bucket, readPixels: pixels.read, tx, ty, clearedAt });

test("a tile with no raster is built from all its pixels; its version is the newest pixel time", async () => {
  const world = setup([
    { x: 1, y: 1, c: 0xff0000, t: 1000 },
    { x: 2, y: 1, c: 0x00ff00, t: 3000 },
    { x: 3, y: 1, c: 0x0000ff, t: 2000 },
  ]);
  const tile = await run(world);
  assert.equal(tile.version, 3000);
  assert.equal(tile.upToDate, false);
  assert.equal(tile.stored, null);
  assert.equal(colorAt(tile.rgba, pixelOffset(1, 1)), 0xff0000);
  assert.equal(colorAt(tile.rgba, pixelOffset(2, 1)), 0x00ff00);
  assert.deepEqual(world.pixels.queries, [{ tx: 0, ty: 0, sinceMs: 0, clearedAt: 0 }], "one query, from the beginning");
});

test("with a raster, only the pixels newer than its version are read", async () => {
  const world = setup([{ x: 1, y: 1, c: 0xff0000, t: 1000 }]);
  const rgba = emptyRaster();
  applyPixels(rgba, [{ x: 1, y: 1, c: 0xff0000 }]);
  await world.bucket.write(0, 0, rgba, 1000);
  world.pixels.paint({ x: 9, y: 9, c: 0x00ff00, t: 1500 });

  const tile = await run(world);
  assert.deepEqual(world.pixels.queries, [{ tx: 0, ty: 0, sinceMs: 1000, clearedAt: 0 }]);
  assert.equal(tile.version, 1500);
  assert.equal(colorAt(tile.rgba, pixelOffset(1, 1)), 0xff0000, "from the raster");
  assert.equal(colorAt(tile.rgba, pixelOffset(9, 9)), 0x00ff00, "from the new pixel");
  assert.ok(tile.stored.generation);
});

test("a repainted pixel takes its new colour over the raster's", async () => {
  const world = setup([{ x: 1, y: 1, c: 0xff0000, t: 1000 }]);
  const rgba = emptyRaster();
  applyPixels(rgba, [{ x: 1, y: 1, c: 0xff0000 }]);
  await world.bucket.write(0, 0, rgba, 1000);
  world.pixels.paint({ x: 1, y: 1, c: 0x0000ff, t: 2000 });
  assert.equal(colorAt((await run(world)).rgba, pixelOffset(1, 1)), 0x0000ff);
});

test("nothing new since the raster: it is already up to date and keeps its version", async () => {
  const world = setup([{ x: 1, y: 1, c: 1, t: 1000 }]);
  const rgba = emptyRaster();
  applyPixels(rgba, [{ x: 1, y: 1, c: 1 }]);
  await world.bucket.write(0, 0, rgba, 1000);
  const tile = await run(world);
  assert.equal(tile.upToDate, true);
  assert.equal(tile.version, 1000);
});

test("a raster older than the last clear is not used: the tile restarts from the clear", async () => {
  const world = setup([
    { x: 1, y: 1, c: 0xff0000, t: 1000 }, // before the clear
    { x: 5, y: 5, c: 0x00ff00, t: 5000 }, // after
  ]);
  const rgba = emptyRaster();
  applyPixels(rgba, [{ x: 1, y: 1, c: 0xff0000 }]);
  await world.bucket.write(0, 0, rgba, 1000);

  const tile = await run(world, 3000);
  assert.deepEqual(world.pixels.queries[0], { tx: 0, ty: 0, sinceMs: 3000, clearedAt: 3000 });
  assert.equal(colorAt(tile.rgba, pixelOffset(1, 1)), -1, "the erased pixel is gone");
  assert.equal(colorAt(tile.rgba, pixelOffset(5, 5)), 0x00ff00);
  assert.equal(tile.version, 5000);
  assert.equal(tile.upToDate, false);
  assert.ok(tile.stored, "the stale raster is reported so that it can be overwritten safely");
});

test("a tile erased and not repainted is blank", async () => {
  const world = setup([{ x: 1, y: 1, c: 0xff0000, t: 1000 }]);
  await world.bucket.write(0, 0, (() => { const r = emptyRaster(); applyPixels(r, [{ x: 1, y: 1, c: 0xff0000 }]); return r; })(), 1000);
  const tile = await run(world, 2000);
  assert.equal(tile.blank, true);
  assert.equal(tile.version, 0);
  assert.ok(tile.stored);
});

test("a tile that never had a pixel is blank and has no stored raster", async () => {
  const tile = await run(setup());
  assert.equal(tile.blank, true);
  assert.equal(tile.stored, null);
  assert.equal(tile.version, 0);
});

test("pixels of another tile are ignored", async () => {
  const world = setup([{ x: 300, y: 1, c: 1, t: 10 }]);
  assert.equal((await run(world, 0, 0, 0)).blank, true);
  assert.equal((await run(world, 0, 1, 0)).blank, false);
});
