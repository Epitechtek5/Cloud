import { test } from "node:test";
import assert from "node:assert/strict";
import { createTileBucket, mapLimit, TileConflictError } from "../../src/tiles/bucket.js";
import { applyPixels, emptyRaster, colorAt, pixelOffset, rasterVersion } from "../../src/tiles/raster.js";
import { fakeStorageBucket } from "./helpers.js";

function raster(pixels = [{ x: 1, y: 2, c: 0x123456 }]) {
  const rgba = emptyRaster();
  applyPixels(rgba, pixels);
  return rgba;
}

test("a tile never rendered reads as null", async () => {
  assert.equal(await createTileBucket(fakeStorageBucket()).read(0, 0), null);
});

test("write then read gives the raster, its version and its generation", async () => {
  const storage = fakeStorageBucket();
  const tiles = createTileBucket(storage);
  await tiles.write(2, 3, raster(), 1234);

  const object = storage.objects.get("2/3.png");
  assert.equal(object.meta.contentType, "image/png");
  assert.equal(object.meta.metadata["tile-version"], "1234", "also listable as object metadata");
  assert.equal(rasterVersion(object.data), 1234, "and inside the PNG, atomically with the bytes");

  const back = await tiles.read(2, 3);
  assert.equal(back.version, 1234);
  assert.equal(back.generation, object.generation);
  assert.equal(colorAt(back.rgba, pixelOffset(1, 2)), 0x123456);
});

test("a write is compare-and-set on the generation read: a concurrent writer wins, the loser gets a conflict", async () => {
  const tiles = createTileBucket(fakeStorageBucket());
  await tiles.write(0, 0, raster(), 1);
  const seen = await tiles.read(0, 0);

  // Someone else writes between our read and our write.
  await tiles.write(0, 0, raster([{ x: 5, y: 5, c: 1 }]), 2, { generation: seen.generation });
  await assert.rejects(tiles.write(0, 0, raster(), 3, { generation: seen.generation }), TileConflictError);
  // A creation must really be one.
  await assert.rejects(tiles.write(0, 0, raster(), 3), TileConflictError);
  assert.equal((await tiles.read(0, 0)).version, 2);
});

test("a storage failure other than a precondition is not hidden", async () => {
  const storage = fakeStorageBucket();
  storage.file = () => ({
    save: async () => Promise.reject(Object.assign(new Error("boom"), { code: 500 })),
    getMetadata: async () => Promise.reject(Object.assign(new Error("boom"), { code: 500 })),
    delete: async () => Promise.reject(Object.assign(new Error("boom"), { code: 500 })),
  });
  const tiles = createTileBucket(storage);
  await assert.rejects(tiles.write(0, 0, raster(), 1), /boom/);
  await assert.rejects(tiles.read(0, 0), /boom/);
  await assert.rejects(tiles.remove(0, 0, { generation: 1 }), /boom/);
  storage.getFilesStream = async function* () {
    yield { name: "0/0.png", metadata: { generation: "1", metadata: { "tile-version": "1" } } };
  };
  await assert.rejects(tiles.deleteStale(5), /boom/);
});

test("a raster deleted between the metadata and the download reads as missing", async () => {
  const storage = fakeStorageBucket();
  const tiles = createTileBucket(storage);
  await tiles.write(0, 0, raster(), 1);
  const original = storage.file.bind(storage);
  storage.file = (name, options) => {
    const file = original(name, options);
    return options?.generation === undefined ? file : { ...file, download: () => Promise.reject(Object.assign(new Error("gone"), { code: 404 })) };
  };
  assert.equal(await tiles.read(0, 0), null);
});

test("a download failure is not hidden either", async () => {
  const storage = fakeStorageBucket();
  const tiles = createTileBucket(storage);
  await tiles.write(0, 0, raster(), 1);
  const original = storage.file.bind(storage);
  storage.file = (name, options) => {
    const file = original(name, options);
    return options?.generation === undefined ? file : { ...file, download: () => Promise.reject(Object.assign(new Error("boom"), { code: 503 })) };
  };
  await assert.rejects(tiles.read(0, 0), /boom/);
});

test("an unreadable raster reads as blank with version 0, so that it is rebuilt and overwritten", async () => {
  const storage = fakeStorageBucket();
  const tiles = createTileBucket(storage);
  await storage.file("1/1.png").save(Buffer.from("garbage"), { metadata: {} });
  const read = await tiles.read(1, 1);
  assert.equal(read.version, 0);
  assert.equal(read.rgba.every((b) => b === 0), true);
  await tiles.write(1, 1, raster(), 9, { generation: read.generation });
  assert.equal((await tiles.read(1, 1)).version, 9);
});

test("remove deletes the raster only if nobody rewrote it, and is idempotent", async () => {
  const storage = fakeStorageBucket();
  const tiles = createTileBucket(storage);
  await tiles.write(0, 0, raster(), 1);
  const { generation } = await tiles.read(0, 0);

  await tiles.write(0, 0, raster(), 2, { generation });
  await tiles.remove(0, 0, { generation }); // stale generation: the newer raster stays
  assert.ok(storage.objects.has("0/0.png"));

  await tiles.remove(0, 0, { generation: (await tiles.read(0, 0)).generation });
  assert.equal(storage.objects.has("0/0.png"), false);
  await tiles.remove(0, 0, { generation }); // already gone: nothing to do
});

test("deleteStale erases the rasters rendered before the clear and keeps the newer ones", async () => {
  const storage = fakeStorageBucket();
  const tiles = createTileBucket(storage);
  await tiles.write(0, 0, raster(), 100); // before the clear
  await tiles.write(0, 1, raster(), 200); // exactly at the clear: erased too
  await tiles.write(1, 0, raster(), 201); // after
  await storage.file("9/9.png").save(Buffer.from("x"), { metadata: {} }); // no version: not trustworthy

  const erased = await tiles.deleteStale(200);
  assert.equal(erased, 3);
  assert.deepEqual([...storage.objects.keys()], ["1/0.png"]);
});

test("deleteStale does not erase a raster that was rewritten after the listing", async () => {
  const storage = fakeStorageBucket();
  const tiles = createTileBucket(storage);
  await tiles.write(0, 0, raster(), 100);
  const list = storage.getFilesStream.bind(storage);
  storage.getFilesStream = async function* () {
    yield* list();
    // A fresh render lands right after the listing.
    await tiles.write(0, 0, raster(), 500, { generation: storage.objects.get("0/0.png").generation });
  };
  await tiles.deleteStale(200);
  assert.equal((await tiles.read(0, 0)).version, 500);
});

test("mapLimit runs at most `limit` tasks at once and keeps the order of the results", async () => {
  let running = 0;
  let peak = 0;
  const results = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 2));
    running--;
    return n * 10;
  });
  assert.deepEqual(results, [10, 20, 30, 40, 50, 60]);
  assert.equal(peak, 2);
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});
