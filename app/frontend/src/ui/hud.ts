import type { Api, PixelInfo } from '../contract';
import { GRID_SIZE } from '../contract';
import type { CanvasApp } from '../canvas/canvasApp';
import { rgbToCss } from '../canvas/geometry';
import type { PixelRef } from '../canvas/renderer';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export class Hud {
  private coords = el('span', 'coords', '—');
  private inspector = el('aside', 'inspector hidden');
  private debug = el('pre', 'debug');
  private inspectToken = 0;
  private app!: CanvasApp;

  constructor(root: HTMLElement, private api: Api, showDebug: boolean) {
    const bar = el('header', 'bar');
    bar.append(el('strong', undefined, 'Pixel Canvas'), this.coords, this.goToForm());
    this.debug.hidden = !showDebug;
    root.append(bar, this.inspector, this.debug);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'd' && !(e.target instanceof HTMLInputElement)) this.debug.hidden = !this.debug.hidden;
      if (e.key === 'Escape') this.app.select(null);
    });
  }

  bind(app: CanvasApp): void {
    this.app = app;
  }

  setHover(p: PixelRef | null): void {
    this.coords.textContent = p ? `${p.x}, ${p.y}` : '—';
  }

  updateDebug(): void {
    if (this.debug.hidden) return;
    const s = this.app.stats;
    this.debug.textContent =
      `zoom     ${s.scale.toFixed(2)}x\ntiles    ${s.tiles} (${s.loading} loading)\n` +
      `deltas   ${s.deltas}\nframe    ${s.frameMs.toFixed(1)} ms`;
  }

  async showPixel(p: PixelRef | null): Promise<void> {
    const token = ++this.inspectToken;
    if (!p) {
      this.inspector.classList.add('hidden');
      return;
    }
    this.inspector.classList.remove('hidden');
    this.inspector.innerHTML = `<h3>Pixel ${p.x}, ${p.y}</h3><p class="muted">Loading…</p>`;
    let info: PixelInfo | null;
    try {
      info = await this.api.pixelInfo(p.x, p.y);
    } catch {
      if (token === this.inspectToken) this.inspector.innerHTML = `<h3>Pixel ${p.x}, ${p.y}</h3><p class="muted">Could not load pixel info.</p>`;
      return;
    }
    if (token !== this.inspectToken) return; // a newer selection superseded this one
    this.inspector.innerHTML = info
      ? `<h3>Pixel ${p.x}, ${p.y}</h3>
         <div class="row"><span class="swatch" style="background:${rgbToCss(info.color)}"></span><code>${rgbToCss(info.color)}</code></div>
         <div class="row"><span class="muted">Author</span> ${escapeHtml(info.authorName)}</div>
         <div class="row"><span class="muted">Updated</span> ${new Date(info.ts).toLocaleString()}</div>`
      : `<h3>Pixel ${p.x}, ${p.y}</h3><p class="muted">Never painted.</p>`;
  }

  private goToForm(): HTMLFormElement {
    const form = el('form', 'goto');
    const x = el('input');
    const y = el('input');
    for (const [i, ph] of [[x, 'x'], [y, 'y']] as const) {
      i.type = 'number';
      i.min = '0';
      i.max = String(GRID_SIZE - 1);
      i.placeholder = ph;
      i.required = true;
    }
    form.append(x, y, el('button', undefined, 'Go'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.app.goTo(Number(x.value), Number(y.value));
      this.app.select({ x: Number(x.value), y: Number(y.value) });
    });
    return form;
  }
}
