import { MAX_BRUSH, MIN_BRUSH } from '../canvas/brush';
import { PALETTE } from '../canvas/palette';
import type { Rgb } from '../contract';

export type Tool = 'inspect' | 'brush';

/** Current tool, brush size and color, shared by the toolbar and the canvas. */
export class ToolState {
  tool: Tool = 'inspect';
  size = 3;
  color: Rgb = PALETTE[5]!;
  private listeners = new Set<() => void>();

  setTool(t: Tool): void {
    this.tool = t;
    this.emit();
  }
  setSize(n: number): void {
    this.size = Math.min(MAX_BRUSH, Math.max(MIN_BRUSH, Math.round(n)));
    this.emit();
  }
  setColor(c: Rgb): void {
    this.color = c;
    this.emit();
  }
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit(): void {
    this.listeners.forEach((cb) => cb());
  }
}
