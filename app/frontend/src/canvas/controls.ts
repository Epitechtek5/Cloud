import type { Tool } from '../ui/toolState';
import { panBy, zoomAt, type Viewport } from './geometry';

export type StrokePhase = 'start' | 'move' | 'end';

export interface ControlsHost {
  getViewport(): Viewport;
  setViewport(vp: Viewport): void;
  getTool(): Tool;
  onTap(sx: number, sy: number): void;
  onStroke(sx: number, sy: number, phase: StrokePhase): void;
  onHover(sx: number, sy: number | null): void;
}

const TAP_SLOP = 5;

type Mode = 'none' | 'pan' | 'stroke';

/**
 * Pointer, wheel and keyboard navigation.
 * - Inspect tool: drag pans, tap selects a pixel.
 * - Brush tool: primary drag paints; pan with middle/right button, Space+drag, or two fingers.
 */
export class Controls {
  private pointers = new Map<number, { x: number; y: number }>();
  private mode: Mode = 'none';
  private moved = 0;
  private lastPinch: { dist: number; mx: number; my: number } | null = null;
  private spaceHeld = false;
  private lastStroke = { x: 0, y: 0 };

  constructor(private el: HTMLElement, private host: ControlsHost) {
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.cancel);
    el.addEventListener('pointerleave', () => this.host.onHover(0, null));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', this.wheel, { passive: false });
    window.addEventListener('keydown', this.key);
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceHeld = false;
    });
  }

  private pos(e: PointerEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private down = (e: PointerEvent): void => {
    this.el.setPointerCapture(e.pointerId);
    const p = this.pos(e);
    this.pointers.set(e.pointerId, p);
    this.lastPinch = null;

    if (this.pointers.size === 2) {
      // A second finger turns a stroke into a pinch/pan gesture.
      if (this.mode === 'stroke') this.host.onStroke(this.lastStroke.x, this.lastStroke.y, 'end');
      this.mode = 'pan';
      this.moved = Infinity;
      return;
    }
    this.moved = 0;
    const paints = this.host.getTool() === 'brush' && e.button === 0 && !this.spaceHeld;
    this.mode = paints ? 'stroke' : 'pan';
    if (paints) {
      this.lastStroke = p;
      this.host.onStroke(p.x, p.y, 'start');
    }
  };

  private move = (e: PointerEvent): void => {
    const p = this.pos(e);
    const prev = this.pointers.get(e.pointerId);
    this.host.onHover(p.x, p.y);
    if (!prev) return;
    this.pointers.set(e.pointerId, p);

    if (this.pointers.size === 1) {
      if (this.mode === 'stroke') {
        this.lastStroke = p;
        this.host.onStroke(p.x, p.y, 'move');
        return;
      }
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      this.moved += Math.abs(dx) + Math.abs(dy);
      if (this.moved > TAP_SLOP) this.host.setViewport(panBy(this.host.getViewport(), dx, dy));
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (this.lastPinch && this.lastPinch.dist > 0) {
        let vp = zoomAt(this.host.getViewport(), mx, my, dist / this.lastPinch.dist);
        vp = panBy(vp, mx - this.lastPinch.mx, my - this.lastPinch.my);
        this.host.setViewport(vp);
      }
      this.lastPinch = { dist, mx, my };
    }
  };

  private up = (e: PointerEvent): void => {
    const p = this.pos(e);
    const wasSingle = this.pointers.size === 1;
    this.pointers.delete(e.pointerId);
    this.lastPinch = null;
    if (wasSingle) {
      if (this.mode === 'stroke') this.host.onStroke(p.x, p.y, 'end');
      else if (this.moved <= TAP_SLOP && this.host.getTool() === 'inspect' && e.button === 0) this.host.onTap(p.x, p.y);
      this.mode = 'none';
    }
  };

  private cancel = (e: PointerEvent): void => {
    if (this.mode === 'stroke' && this.pointers.size === 1) this.host.onStroke(this.lastStroke.x, this.lastStroke.y, 'end');
    this.pointers.delete(e.pointerId);
    this.lastPinch = null;
    if (this.pointers.size === 0) this.mode = 'none';
  };

  private wheel = (e: WheelEvent): void => {
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    // Trackpad pinch arrives as ctrl+wheel with small deltas; mouse wheels send larger ones.
    const k = e.ctrlKey ? 0.01 : 0.0015;
    this.host.setViewport(zoomAt(this.host.getViewport(), e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * k)));
  };

  private key = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.code === 'Space') {
      this.spaceHeld = true;
      e.preventDefault();
      return;
    }
    const vp = this.host.getViewport();
    const step = 80;
    switch (e.key) {
      case 'ArrowLeft': this.host.setViewport(panBy(vp, step, 0)); break;
      case 'ArrowRight': this.host.setViewport(panBy(vp, -step, 0)); break;
      case 'ArrowUp': this.host.setViewport(panBy(vp, 0, step)); break;
      case 'ArrowDown': this.host.setViewport(panBy(vp, 0, -step)); break;
      case '+': case '=': this.host.setViewport(zoomAt(vp, vp.width / 2, vp.height / 2, 1.25)); break;
      case '-': this.host.setViewport(zoomAt(vp, vp.width / 2, vp.height / 2, 0.8)); break;
      default: return;
    }
    e.preventDefault();
  };
}
