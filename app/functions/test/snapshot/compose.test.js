import { test } from "node:test";
import assert from "node:assert/strict";
import { composeSnapshot, snapshotObjectName } from "../../src/snapshot/compose.js";
import { loadNotifierConfig, loadSnapshotWorkerConfig } from "../../src/snapshot/config.js";

const at = (img, gx, gy) => {
  // Colour of the grid pixel (gx, gy) in the image.
  const ix = Math.floor((gx - img.x0) / img.factor) * img.upscale;
  const iy = Math.floor((gy - img.y0) / img.factor) * img.upscale;
  const i = (iy * img.width + ix) * 4;
  return (img.rgba[i] << 16) | (img.rgba[i + 1] << 8) | img.rgba[i + 2];
};

test("an empty canvas gives a blank square at the centre", () => {
  const img = composeSnapshot([]);
  assert.deepEqual([img.x0, img.y0, img.side, img.factor], [49968, 49968, 64, 1]);
  assert.equal(img.width, 512);
  assert.ok(img.rgba.every((v, i) => v === 255 || i % 4 === 3));
});

test("a small painted area is rendered 1:1, enlarged to at least 512 px", () => {
  const img = composeSnapshot([
    { x: 100, y: 100, c: 0xff0000, t: 1 },
    { x: 110, y: 105, c: 0x0000ff, t: 2 },
  ]);
  assert.equal(img.factor, 1);
  assert.equal(img.side, 11 + 16);
  assert.ok(img.width >= 512);
  assert.equal(at(img, 100, 100), 0xff0000);
  assert.equal(at(img, 110, 105), 0x0000ff);
  assert.equal(at(img, 101, 100), 0xffffff);
});

test("a large area is downscaled, the most recent pixel of a block wins", () => {
  const img = composeSnapshot(
    [
      { x: 0, y: 0, c: 0x111111, t: 5 },
      { x: 1, y: 0, c: 0x222222, t: 9 },
      { x: 2, y: 1, c: 0x333333, t: 1 },
      { x: 99999, y: 99999, c: 0x444444, t: 1 },
    ],
    { maxSide: 1000 },
  );
  assert.deepEqual([img.x0, img.y0, img.side, img.factor], [0, 0, 100000, 100]);
  assert.equal(img.width, 1000);
  assert.equal(at(img, 0, 0), 0x222222);
  assert.equal(at(img, 99999, 99999), 0x444444);
});

test("object names are timestamped and stable for one request", () => {
  const t = Date.UTC(2026, 10, 16, 12, 3, 4, 567);
  assert.equal(snapshotObjectName(t, "1300000000000000004"), "snapshots/2026/11/16/2026-11-16T12-03-04-567Z_1300000000000000004.png");
  assert.equal(snapshotObjectName(t, "r"), snapshotObjectName(t, "r"));
});

test("configuration", () => {
  assert.throws(() => loadSnapshotWorkerConfig({}), /SNAPSHOTS_BUCKET/);
  assert.deepEqual(loadSnapshotWorkerConfig({ SNAPSHOTS_BUCKET: "b" }), { bucket: "b", maxPixels: 2_000_000 });
  assert.equal(loadSnapshotWorkerConfig({ SNAPSHOTS_BUCKET: "b", MAX_SNAPSHOT_PIXELS: "10" }).maxPixels, 10);
  assert.deepEqual(loadNotifierConfig({}), { ttlSeconds: 3600 });
  assert.equal(loadNotifierConfig({ SIGNED_URL_TTL_SECONDS: "900" }).ttlSeconds, 900);
  assert.throws(() => loadNotifierConfig({ SIGNED_URL_TTL_SECONDS: "604801" }), /SIGNED_URL_TTL_SECONDS/);
});
