import { TILE_SIZE } from '../contract';
import type { TileSurface } from './tileManager';

/** A tile backed by its own canvas; only changed pixels are ever redrawn on it. */
export class CanvasTileSurface implements TileSurface {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = TILE_SIZE;
    this.canvas.height = TILE_SIZE;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas not supported');
    this.ctx = ctx;
  }

  putRaster(rgba: Uint8ClampedArray): void {
    this.ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), TILE_SIZE, TILE_SIZE), 0, 0);
  }

  setPixel(x: number, y: number, css: string): void {
    this.ctx.fillStyle = css;
    this.ctx.fillRect(x, y, 1, 1);
  }

  clearPixel(x: number, y: number): void {
    this.ctx.clearRect(x, y, 1, 1);
  }
}
