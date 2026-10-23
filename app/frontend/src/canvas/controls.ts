import { panBy, zoomAt, type Viewport } from './geometry';

export interface ControlsHost {
  getViewport(): Viewport;
  setViewport(vp: Viewport): void;
  onTap(sx: number, sy: number): void;
  onHover(sx: number, sy: number | null): void;
}

const TAP_SLOP = 5;

/** Pointer (drag + pinch), wheel and keyboard navigation. */
export class Controls {
  private pointers = new Map<number, { x: number; y: number }>();
  private moved = 0;
  private lastPinch: { dist: number; mx: number; my: number } | null = null;

  constructor(private el: HTMLElement, private host: ControlsHost) {
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.cancel);
    el.addEventListener('pointerleave', () => this.host.onHover(0, null));
    el.addEventListener('wheel', this.wheel, { passive: false });
    window.addEventListener('keydown', this.key);
  }

  private pos(e: PointerEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private down = (e: PointerEvent): void => {
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.pos(e));
    if (this.pointers.size === 1) this.moved = 0;
    this.lastPinch = null;
  };

  private move = (e: PointerEvent): void => {
    const p = this.pos(e);
    const prev = this.pointers.get(e.pointerId);
    if (!prev) {
      this.host.onHover(p.x, p.y);
      return;
    }
    this.pointers.set(e.pointerId, p);

    if (this.pointers.size === 1) {
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      this.moved += Math.abs(dx) + Math.abs(dy);
      if (this.moved > TAP_SLOP) this.host.setViewport(panBy(this.host.getViewport(), dx, dy));
    } else if (this.pointers.size === 2) {
      this.moved = Infinity;
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
    if (wasSingle && this.moved <= TAP_SLOP) this.host.onTap(p.x, p.y);
  };

  private cancel = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.lastPinch = null;
  };

  private wheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = { x: e.clientX - this.el.getBoundingClientRect().left, y: e.clientY - this.el.getBoundingClientRect().top };
    // Trackpad pinch arrives as ctrl+wheel with small deltas; mouse wheels send larger ones.
    const k = e.ctrlKey ? 0.01 : 0.0015;
    this.host.setViewport(zoomAt(this.host.getViewport(), p.x, p.y, Math.exp(-e.deltaY * k)));
  };

  private key = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
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
