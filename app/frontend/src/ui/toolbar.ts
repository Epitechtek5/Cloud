import { MAX_BRUSH, MIN_BRUSH } from '../canvas/brush';
import { rgbToCss } from '../canvas/geometry';
import { PALETTE } from '../canvas/palette';
import type { DrawController, Notice } from '../draw/drawController';
import type { ToolState } from './toolState';

const TOAST_MS = 4000;

function mk<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class Toolbar {
  private inspectBtn = mk('button', 'tool', 'Inspect (V)');
  private brushBtn = mk('button', 'tool', 'Brush (B)');
  private sizeInput = mk('input');
  private sizeLabel = mk('span', 'muted');
  private swatches: HTMLButtonElement[] = [];
  private custom = mk('input');
  private quota = mk('div', 'quota muted');
  private banner = mk('div', 'banner hidden', 'Drawing is paused by an admin');
  private toasts = mk('div', 'toasts');

  constructor(root: HTMLElement, private tools: ToolState) {
    const panel = mk('aside', 'toolbar');

    const modes = mk('div', 'row');
    modes.append(this.inspectBtn, this.brushBtn);
    this.inspectBtn.onclick = () => tools.setTool('inspect');
    this.brushBtn.onclick = () => tools.setTool('brush');

    this.sizeInput.type = 'range';
    this.sizeInput.min = String(MIN_BRUSH);
    this.sizeInput.max = String(MAX_BRUSH);
    this.sizeInput.oninput = () => tools.setSize(Number(this.sizeInput.value));
    const size = mk('label', 'col');
    size.append(this.sizeLabel, this.sizeInput);

    const palette = mk('div', 'palette');
    for (const c of PALETTE) {
      const b = mk('button', 'swatch');
      b.style.background = rgbToCss(c);
      b.title = rgbToCss(c);
      b.onclick = () => tools.setColor(c);
      this.swatches.push(b);
      palette.append(b);
    }
    this.custom.type = 'color';
    this.custom.title = 'Custom color';
    this.custom.oninput = () => tools.setColor(parseInt(this.custom.value.slice(1), 16));

    panel.append(modes, size, palette, this.custom, this.quota);
    root.append(panel, this.banner, this.toasts);

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey) return;
      if (e.key === 'b') tools.setTool('brush');
      else if (e.key === 'v') tools.setTool('inspect');
      else if (e.key === '[') tools.setSize(tools.size - 1);
      else if (e.key === ']') tools.setSize(tools.size + 1);
    });

    tools.subscribe(() => this.syncTools());
    this.syncTools();
  }

  /** Reflects the draw controller state (quota, pause). */
  syncDraw(draw: DrawController): void {
    this.banner.classList.toggle('hidden', !draw.paused);
    this.quota.textContent = draw.quota ? `Pixels left: ${draw.quota.remaining} / ${draw.quota.limit} per minute` : '';
  }

  toast(n: Notice): void {
    const t = mk('div', `toast ${n.level}`, n.text);
    this.toasts.append(t);
    setTimeout(() => t.remove(), TOAST_MS);
  }

  private syncTools(): void {
    const { tool, size, color } = this.tools;
    this.inspectBtn.classList.toggle('active', tool === 'inspect');
    this.brushBtn.classList.toggle('active', tool === 'brush');
    this.sizeInput.value = String(size);
    this.sizeLabel.textContent = `Brush size: ${size} x ${size}`;
    this.sizeInput.disabled = tool !== 'brush';
    this.swatches.forEach((b, i) => b.classList.toggle('selected', PALETTE[i] === color));
    this.custom.value = rgbToCss(color);
  }
}
