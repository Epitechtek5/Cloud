import { GRID_SIZE, type Backend } from '../contract';
import type { DrawController } from '../draw/drawController';
import type { ToolState } from '../ui/toolState';
import { strokePixels, type Point } from './brush';
import { Controls, type StrokePhase } from './controls';
import {
  clampViewport,
  inGrid,
  screenToGrid,
  visibleTileRange,
  type Viewport,
} from './geometry';
import { Renderer, type PixelRef } from './renderer';
import { CanvasTileSurface } from './surface';
import { TileManager } from './tileManager';

/** Tiles kept (and subscribed) beyond the visible ones, to hide loading while panning. */
const PREFETCH_MARGIN = 1;

export interface CanvasHooks {
  onSelect(pixel: PixelRef | null): void;
  onHover(pixel: PixelRef | null): void;
  onViewportChange(vp: Viewport): void;
  /** Called after each rendered frame (viewport move or incoming deltas). */
  onFrame(): void;
}

export class CanvasApp {
  private vp: Viewport;
  private renderer: Renderer;
  private tiles: TileManager<CanvasTileSurface>;
  private selection: PixelRef | null = null;
  private hover: PixelRef | null = null;
  private dirty = false;
  private raf = 0;
  lastFrameMs = 0;

  private lastStroke: Point | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    backend: Backend,
    private hooks: CanvasHooks,
    private draw: DrawController,
    private tools: ToolState,
  ) {
    this.renderer = new Renderer(canvas);
    this.vp = { cx: GRID_SIZE / 2, cy: GRID_SIZE / 2, scale: 4, width: 1, height: 1 };
    this.tiles = new TileManager(
      backend.tiles,
      backend.realtime,
      () => new CanvasTileSurface(),
      () => this.requestDraw(),
      (d) => this.draw.onDelta(d),
    );
    this.tools.subscribe(() => {
      canvas.style.cursor = this.tools.tool === 'brush' ? 'crosshair' : 'default';
      this.requestDraw();
    });

    new Controls(canvas, {
      getViewport: () => this.vp,
      setViewport: (vp) => this.setViewport(vp),
      getTool: () => this.tools.tool,
      onStroke: (sx, sy, phase) => this.stroke(sx, sy, phase),
      onTap: (sx, sy) => this.select(this.pixelAt(sx, sy)),
      onHover: (sx, sy) => {
        const p = sy === null ? null : this.pixelAt(sx, sy);
        this.hover = p;
        this.hooks.onHover(p);
        this.requestDraw();
      },
    });
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement ?? canvas);
    this.resize();
  }

  get stats() {
    return {
      scale: this.vp.scale,
      tiles: this.tiles.size,
      loading: this.tiles.loadingCount,
      deltas: this.tiles.deltaCount,
      frameMs: this.lastFrameMs,
      pending: this.draw.pending.size,
    };
  }

  get viewport(): Viewport {
    return this.vp;
  }

  goTo(x: number, y: number, scale = Math.max(this.vp.scale, 8)): void {
    this.setViewport({ ...this.vp, cx: x + 0.5, cy: y + 0.5, scale });
  }

  select(p: PixelRef | null): void {
    this.selection = p;
    this.hooks.onSelect(p);
    this.requestDraw();
  }

  requestDraw(): void {
    this.dirty = true;
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private stroke(sx: number, sy: number, phase: StrokePhase): void {
    if (phase === 'end') {
      this.lastStroke = null;
      this.draw.flush();
      return;
    }
    const p = this.pixelAt(sx, sy);
    if (!p) {
      this.lastStroke = null; // left the grid: do not draw a line across the gap
      return;
    }
    this.draw.paint(strokePixels(phase === 'start' ? null : this.lastStroke, p, this.tools.size, this.tools.color));
    this.lastStroke = p;
  }

  /** Paints a single pixel with the current color (inspector button). */
  paintPixel(p: PixelRef): void {
    this.draw.paint([{ x: p.x, y: p.y, color: this.tools.color }]);
    this.draw.flush();
  }

  private pixelAt(sx: number, sy: number): PixelRef | null {
    const g = screenToGrid(this.vp, sx, sy);
    const p = { x: Math.floor(g.x), y: Math.floor(g.y) };
    return inGrid(p.x, p.y) ? p : null;
  }

  private setViewport(vp: Viewport): void {
    this.vp = clampViewport(vp);
    this.tiles.setVisible(visibleTileRange(this.vp, PREFETCH_MARGIN));
    this.hooks.onViewportChange(this.vp);
    this.requestDraw();
  }

  private resize(): void {
    const parent = this.canvas.parentElement ?? this.canvas;
    const width = parent.clientWidth;
    const height = parent.clientHeight;
    this.renderer.resize(width, height);
    this.setViewport({ ...this.vp, width, height });
  }

  private frame = (): void => {
    this.raf = 0;
    if (!this.dirty) return;
    this.dirty = false;
    const t0 = performance.now();
    this.renderer.render({
      vp: this.vp,
      getTile: (tx, ty) => this.tiles.get(tx, ty),
      pending: this.draw.pending.values(),
      brush: this.tools.tool === 'brush' && this.hover ? { ...this.hover, size: this.tools.size } : null,
      selection: this.selection,
      hover: this.hover,
    });
    this.lastFrameMs = performance.now() - t0;
    this.hooks.onFrame();
  };
}
