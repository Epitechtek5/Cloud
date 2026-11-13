// Contract between the frontend and the backend (see plan, phase 0).
// Everything the UI needs goes through these interfaces so that the GCP
// implementation and the in-browser mock are interchangeable.

export const GRID_SIZE = 100_000;
export const TILE_SIZE = 256;
export const TILES_PER_SIDE = Math.ceil(GRID_SIZE / TILE_SIZE);

/** 0xRRGGBB */
export type Rgb = number;

export interface PixelInfo {
  x: number;
  y: number;
  color: Rgb;
  /** Discord user id */
  author: string;
  authorName: string;
  /** epoch ms */
  ts: number;
}

/** Changed pixel pushed by the real-time channel (only deltas, never full tiles). */
export interface PixelDelta {
  x: number;
  y: number;
  color: Rgb;
  author: string;
  ts: number;
}

export interface DrawPixel {
  x: number;
  y: number;
  color: Rgb;
}

export interface SessionState {
  paused: boolean;
}

export type UserEvent =
  | { type: 'rejected'; reason: 'rate_limited' | 'paused' | 'invalid'; batchId: string; pixels: DrawPixel[] }
  | { type: 'quota'; remaining: number; limit: number };

export type Unsubscribe = () => void;

/** Initial raster of a tile, with the version it was rendered at. */
export interface TileRaster {
  /** RGBA, TILE_SIZE*TILE_SIZE*4. Unpainted pixels have alpha 0. `null` when nothing was ever painted there. */
  rgba: Uint8ClampedArray | null;
  /** Epoch ms of the most recent pixel included in the raster (`X-Tile-Version`); 0 for an empty tile. */
  version: number;
}

export interface TileSource {
  loadTile(tx: number, ty: number, signal: AbortSignal): Promise<TileRaster>;
}

export interface TileSubscriptionOptions {
  /**
   * `TileRaster.version` of the raster already displayed. The channel first delivers the pixels
   * strictly newer than this (what the raster misses), then every live change.
   */
  since: number;
}

export interface RealtimeChannel {
  subscribeTile(
    tx: number,
    ty: number,
    onDeltas: (deltas: PixelDelta[]) => void,
    options: TileSubscriptionOptions,
  ): Unsubscribe;
  subscribeSession(onState: (state: SessionState) => void): Unsubscribe;
  subscribeUserEvents(onEvent: (event: UserEvent) => void): Unsubscribe;
}

/** Authenticated calls going through API Gateway -> proxy -> broker. */
export interface Api {
  /** Resolves once the batch is accepted (HTTP 202); the result arrives through the RealtimeChannel. */
  draw(pixels: DrawPixel[], batchId: string): Promise<void>;
  pixelInfo(x: number, y: number): Promise<PixelInfo | null>;
}

export interface Backend {
  tiles: TileSource;
  realtime: RealtimeChannel;
  api: Api;
}

export const MAX_DRAW_BATCH = 256;
