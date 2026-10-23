import { GRID_SIZE, TILE_SIZE } from '../contract';
import { gridToScreen, visibleTileRange, type Viewport } from './geometry';
import type { CanvasTileSurface } from './surface';

export interface PixelRef {
  x: number;
  y: number;
}

export interface RenderState {
  vp: Viewport;
  getTile: (tx: number, ty: number) => CanvasTileSurface | undefined;
  selection: PixelRef | null;
  hover: PixelRef | null;
}

const OUTSIDE = '#1e1f22';
const EMPTY = '#ffffff';
const ACCENT = '#5865f2';

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas not supported');
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  render({ vp, getTile, selection, hover }: RenderState): void {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = OUTSIDE;
    ctx.fillRect(0, 0, vp.width, vp.height);

    const origin = gridToScreen(vp, 0, 0);
    const end = gridToScreen(vp, GRID_SIZE, GRID_SIZE);
    ctx.fillStyle = EMPTY;
    ctx.fillRect(origin.sx, origin.sy, end.sx - origin.sx, end.sy - origin.sy);

    const r = visibleTileRange(vp);
    for (let ty = r.ty0; ty <= r.ty1; ty++) {
      for (let tx = r.tx0; tx <= r.tx1; tx++) {
        const tile = getTile(tx, ty);
        if (!tile) continue;
        // Snap both edges to whole screen pixels so neighbouring tiles never leave seams.
        const a = gridToScreen(vp, tx * TILE_SIZE, ty * TILE_SIZE);
        const b = gridToScreen(vp, (tx + 1) * TILE_SIZE, (ty + 1) * TILE_SIZE);
        const x0 = Math.floor(a.sx);
        const y0 = Math.floor(a.sy);
        ctx.drawImage(tile.canvas, x0, y0, Math.floor(b.sx) - x0, Math.floor(b.sy) - y0);
      }
    }

    if (vp.scale >= 10) this.drawPixelGrid(vp);
    if (hover && vp.scale >= 4) this.outline(vp, hover, 'rgba(88,101,242,0.55)', 1);
    if (selection) this.outline(vp, selection, ACCENT, 2);
  }

  private drawPixelGrid(vp: Viewport): void {
    const { ctx } = this;
    const tl = { x: Math.max(0, Math.floor(vp.cx - vp.width / 2 / vp.scale)), y: Math.max(0, Math.floor(vp.cy - vp.height / 2 / vp.scale)) };
    const br = {
      x: Math.min(GRID_SIZE, Math.ceil(vp.cx + vp.width / 2 / vp.scale)),
      y: Math.min(GRID_SIZE, Math.ceil(vp.cy + vp.height / 2 / vp.scale)),
    };
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = tl.x; x <= br.x; x++) {
      const s = Math.round(gridToScreen(vp, x, 0).sx) + 0.5;
      ctx.moveTo(s, 0);
      ctx.lineTo(s, vp.height);
    }
    for (let y = tl.y; y <= br.y; y++) {
      const s = Math.round(gridToScreen(vp, 0, y).sy) + 0.5;
      ctx.moveTo(0, s);
      ctx.lineTo(vp.width, s);
    }
    ctx.stroke();
  }

  private outline(vp: Viewport, p: PixelRef, color: string, width: number): void {
    const { sx, sy } = gridToScreen(vp, p.x, p.y);
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = width;
    const size = Math.max(vp.scale, 4);
    const off = (size - vp.scale) / 2;
    this.ctx.strokeRect(sx - off + width / 2, sy - off + width / 2, size - width, size - width);
  }
}
