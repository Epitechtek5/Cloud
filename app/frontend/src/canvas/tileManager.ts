import { TILE_SIZE, type PixelDelta, type RealtimeChannel, type TileSource, type Unsubscribe } from '../contract';
import { rgbToCss, tileKey, tileOfPixel, type TileRange } from './geometry';

/** Where a tile's pixels are drawn. Abstracted so the logic is testable without a DOM. */
export interface TileSurface {
  putRaster(rgba: Uint8ClampedArray): void;
  setPixel(localX: number, localY: number, css: string): void;
  clearPixel(localX: number, localY: number): void;
}

export type SurfaceFactory = (tx: number, ty: number) => TileSurface;

interface Entry<S> {
  tx: number;
  ty: number;
  surface: S;
  ready: boolean;
  abort: AbortController;
  unsubscribe: Unsubscribe;
}

/**
 * Keeps exactly the tiles around the viewport alive. A tile is subscribed to the
 * real-time channel (right after its raster is loaded) for as long as it is cached, so a
 * cached tile is never stale: leaving the (margin-extended) viewport drops both the raster
 * and the subscription.
 */
export class TileManager<S extends TileSurface = TileSurface> {
  private entries = new Map<string, Entry<S>>();
  /** Total deltas applied since start (debug overlay). */
  deltaCount = 0;

  constructor(
    private source: TileSource,
    private realtime: RealtimeChannel,
    private createSurface: (tx: number, ty: number) => S,
    private onChange: () => void,
    private onDelta?: (d: PixelDelta) => void,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get loadingCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (!e.ready) n++;
    return n;
  }

  get(tx: number, ty: number): S | undefined {
    const e = this.entries.get(tileKey(tx, ty));
    return e?.ready ? e.surface : undefined;
  }

  /** Call whenever the viewport changes. `keep` already includes the prefetch margin. */
  setVisible(keep: TileRange): void {
    for (const [key, e] of this.entries) {
      if (e.tx < keep.tx0 || e.tx > keep.tx1 || e.ty < keep.ty0 || e.ty > keep.ty1) {
        this.evict(key, e);
      }
    }
    for (let ty = keep.ty0; ty <= keep.ty1; ty++) {
      for (let tx = keep.tx0; tx <= keep.tx1; tx++) {
        if (!this.entries.has(tileKey(tx, ty))) this.open(tx, ty);
      }
    }
  }

  dispose(): void {
    for (const [key, e] of this.entries) this.evict(key, e);
  }

  private open(tx: number, ty: number): void {
    const key = tileKey(tx, ty);
    const entry: Entry<S> = {
      tx,
      ty,
      surface: this.createSurface(tx, ty),
      ready: false,
      abort: new AbortController(),
      unsubscribe: () => {},
    };
    this.entries.set(key, entry);

    // Raster first, subscription second. The raster carries a version (the time of its newest
    // pixel); subscribing "since" that version makes the channel deliver exactly what the raster
    // misses, then live changes. Nothing is lost between the two and nothing has to be buffered.
    this.source
      .loadTile(tx, ty, entry.abort.signal)
      .then((raster) => {
        if (this.entries.get(key) !== entry) return; // evicted meanwhile: do not subscribe
        if (raster.rgba) entry.surface.putRaster(raster.rgba);
        entry.ready = true;
        entry.unsubscribe = this.realtime.subscribeTile(tx, ty, (deltas) => this.apply(entry, deltas), {
          since: raster.version,
        });
        this.onChange(); // the raster itself is now visible
      })
      .catch(() => {
        // Network failure: forget the tile so the next viewport change retries it.
        if (this.entries.get(key) === entry) this.evict(key, entry);
      });
  }

  private apply(entry: Entry<S>, deltas: PixelDelta[]): void {
    for (const d of deltas) {
      if (tileOfPixel(d.x) !== entry.tx || tileOfPixel(d.y) !== entry.ty) continue;
      const lx = d.x - entry.tx * TILE_SIZE;
      const ly = d.y - entry.ty * TILE_SIZE;
      // A negative color means "cleared" (admin /clear).
      if (d.color < 0) entry.surface.clearPixel(lx, ly);
      else entry.surface.setPixel(lx, ly, rgbToCss(d.color));
      this.onDelta?.(d);
    }
    this.deltaCount += deltas.length;
    if (deltas.length > 0) this.onChange();
  }

  private evict(key: string, e: Entry<S>): void {
    e.abort.abort();
    e.unsubscribe();
    this.entries.delete(key);
  }
}
