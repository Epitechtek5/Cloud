import './style.css';
import { createBackend } from './backend';
import { CanvasApp } from './canvas/canvasApp';
import { config } from './config';
import { Hud } from './ui/hud';

async function main(): Promise<void> {
  const root = document.getElementById('app')!;
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const backend = await createBackend();

  const hud = new Hud(root, backend.api, config.env !== 'prd');
  const app = new CanvasApp(canvas, backend, {
    onSelect: (p) => void hud.showPixel(p),
    onHover: (p) => hud.setHover(p),
    onViewportChange: () => {},
    onFrame: () => hud.updateDebug(),
  });
  hud.bind(app);

  app.requestDraw();
}

void main();
