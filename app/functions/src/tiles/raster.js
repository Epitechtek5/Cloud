// A tile raster: the 256 x 256 RGBA image of one tile, and its version.
//
// Alpha is 0 for a pixel never painted and 255 for a painted one (the front
// relies on it, docs/frontend-contract.md §2). The version is the time of the
// newest pixel the raster contains, in epoch ms, rounded DOWN: the front then
// asks Firestore for `t > version`, so a pixel in the same millisecond comes
// twice (harmless, the same colour is applied again). Rounding up would skip
// the pixels between the version and the next millisecond: they would be lost.
import { encodePng } from "../lib/png.js";
import { decodePng, PngError, readPngText } from "../lib/pngDecode.js";
import { TILE_SIZE, TILES_PER_SIDE } from "../lib/grid.js";

export { TILE_SIZE, TILES_PER_SIDE };

// `tEXt` key holding the version inside the PNG, so that the image and its
// version are one object (no race between the bytes and a separate header).
export const VERSION_KEY = "Tile-Version";
// The same value as custom metadata of the object, to list or sweep without downloading.
export const VERSION_METADATA = "tile-version";

/** Object name of a tile in the bucket: `{tx}/{ty}.png`, the path the front requests. */
export function tileName(tx, ty) {
  return `${tx}/${ty}.png`;
}

/** `tx_ty` (the `tile` field of the pixel documents) to numbers. */
export function parseTile(tile) {
  const [tx, ty] = tile.split("_").map(Number);
  return { tx, ty };
}

export function tileId(tx, ty) {
  return `${tx}_${ty}`;
}

export function inTileGrid(tx, ty) {
  return Number.isInteger(tx) && Number.isInteger(ty) && tx >= 0 && ty >= 0 && tx < TILES_PER_SIDE && ty < TILES_PER_SIDE;
}

/** Tiles (`tx_ty`, without duplicates) touched by pixels. */
export function tilesOfPixels(pixels) {
  return [...new Set(pixels.map(({ x, y }) => tileId(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE))))];
}

/** Byte offset of the grid pixel (x, y) in the RGBA array of its tile. */
export function pixelOffset(x, y) {
  return ((y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE)) * 4;
}

/** A fully transparent raster. */
export function emptyRaster() {
  return new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
}

/** Paints `{ x, y, c }` pixels (all inside the tile) into `rgba`; later ones win. */
export function applyPixels(rgba, pixels) {
  for (const { x, y, c } of pixels) {
    const i = pixelOffset(x, y);
    rgba[i] = (c >> 16) & 0xff;
    rgba[i + 1] = (c >> 8) & 0xff;
    rgba[i + 2] = c & 0xff;
    rgba[i + 3] = 0xff;
  }
}

/** True when no pixel of the raster was ever painted. */
export function isBlank(rgba) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) return false;
  return true;
}

/** Colour (0xRRGGBB) of the painted pixel at `offset`, or -1 when it is transparent. */
export function colorAt(rgba, offset) {
  return rgba[offset + 3] === 0 ? -1 : (rgba[offset] << 16) | (rgba[offset + 1] << 8) | rgba[offset + 2];
}

export function encodeRaster(rgba, version) {
  return encodePng(TILE_SIZE, TILE_SIZE, rgba, { text: { [VERSION_KEY]: String(version) } });
}

/**
 * Version stored in a raster, read without inflating the image.
 * @throws {PngError} when the PNG has no valid version
 */
export function rasterVersion(png) {
  return versionOf(readPngText(png));
}

function versionOf(text) {
  const raw = text[VERSION_KEY];
  if (raw === undefined || !/^\d{1,16}$/.test(raw)) throw new PngError("raster without a valid version");
  return Number(raw);
}

/**
 * @returns {{ rgba: Uint8Array, version: number }}
 * @throws {PngError} when it is not a 256 x 256 raster of ours
 */
export function decodeRaster(png) {
  const { width, height, rgba, text } = decodePng(png, { maxPixels: TILE_SIZE * TILE_SIZE });
  if (width !== TILE_SIZE || height !== TILE_SIZE) throw new PngError("raster has the wrong size");
  return { rgba, version: versionOf(text) };
}
