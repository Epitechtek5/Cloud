import { test } from "node:test";
import assert from "node:assert/strict";
import { inGrid, pixelId, tileOf, tilesOfRect, TILES_PER_SIDE } from "../../src/lib/grid.js";
import { snowflakeTime } from "../../src/lib/snowflake.js";

test("tiles are 256x256 and keyed tx_ty", () => {
  assert.equal(TILES_PER_SIDE, 391);
  assert.equal(tileOf(0, 0), "0_0");
  assert.equal(tileOf(255, 256), "0_1");
  assert.equal(tileOf(99999, 99999), "390_390");
  assert.equal(pixelId(10, 20), "10_20");
});

test("inGrid accepts 0..99999 integers only", () => {
  assert.ok(inGrid(0, 99999));
  for (const [x, y] of [[-1, 0], [0, 100000], [1.5, 2], ["1", 2], [undefined, 0]]) assert.equal(inGrid(x, y), false);
});

test("tilesOfRect lists the covered tiles, clipped to the grid", () => {
  assert.deepEqual(tilesOfRect(0, 0, 256, 256), ["0_0"]);
  assert.deepEqual(tilesOfRect(200, 250, 100, 10), ["0_0", "1_0", "0_1", "1_1"]);
  assert.deepEqual(tilesOfRect(99990, 99990, 64, 64), ["390_390"]);
});

test("snowflakeTime decodes the creation time of a Discord id", () => {
  // Example of the Discord documentation: 175928847299117063 -> 2016-04-30T11:18:25.796Z
  assert.equal(new Date(snowflakeTime("175928847299117063")).toISOString(), "2016-04-30T11:18:25.796Z");
});
