// Geometry of the grid and names of the Firestore documents (docs/data-model.md).
import { GRID_SIZE } from "./events.js";

export const TILE_SIZE = 256;
export const TILES_PER_SIDE = Math.ceil(GRID_SIZE / TILE_SIZE);

// Firestore collections and documents (docs/data-model.md §1).
export const COLLECTIONS = Object.freeze({
  pixels: "pixels",
  users: "users",
  userEvents: "userEvents",
  processedBatches: "processedBatches",
  processedCommands: "processedCommands",
});
export const SESSION_STATE = "session/state";

/** `tx_ty` of the 256x256 tile that holds (x, y). */
export function tileOf(x, y) {
  return `${Math.floor(x / TILE_SIZE)}_${Math.floor(y / TILE_SIZE)}`;
}

/** Document id of a pixel: `pixels/{x}_{y}`. */
export function pixelId(x, y) {
  return `${x}_${y}`;
}

export function inGrid(x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE;
}

/** Tiles (`tx_ty`) covered by the rectangle [x0, x0 + w) x [y0, y0 + h), clipped to the grid. */
export function tilesOfRect(x0, y0, w, h) {
  const tx0 = Math.floor(Math.max(0, x0) / TILE_SIZE);
  const ty0 = Math.floor(Math.max(0, y0) / TILE_SIZE);
  const tx1 = Math.floor((Math.min(GRID_SIZE, x0 + w) - 1) / TILE_SIZE);
  const ty1 = Math.floor((Math.min(GRID_SIZE, y0 + h) - 1) / TILE_SIZE);
  const tiles = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) tiles.push(`${tx}_${ty}`);
  return tiles;
}
