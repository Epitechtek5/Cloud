import './style.css';
import { createBackend } from './backend';
import { CanvasApp } from './canvas/canvasApp';
import { DrawController } from './draw/drawController';
import { Hud } from './ui/hud';
import { Toolbar } from './ui/toolbar';
import { ToolState } from './ui/toolState';

async function main(): Promise<void> {
  const root = document.getElementById('app')!;
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const backend = await createBackend();

  const hud = new Hud(root, backend.api, import.meta.env.DEV || new URLSearchParams(location.search).has('debug'));
  const tools = new ToolState();
  const toolbar = new Toolbar(root, tools);
  // The draw controller is created first (the app needs it) but must trigger redraws of the app.
  // The channel may emit synchronously on subscribe (initial quota/session), i.e. during the
  // constructor, so the callbacks must tolerate `ref` not being filled yet.
  const ref: { app?: CanvasApp; draw?: DrawController } = {};
  const draw = (ref.draw = new DrawController(backend.api, backend.realtime, {
    onChange: () => {
      ref.app?.requestDraw();
      if (ref.draw) toolbar.syncDraw(ref.draw);
    },
    onNotice: (n) => toolbar.toast(n),
  }));
  toolbar.syncDraw(draw);
  const app = (ref.app = new CanvasApp(canvas, backend, {
    onSelect: (p) => void hud.showPixel(p),
    onHover: (p) => hud.setHover(p),
    onViewportChange: () => {},
    onFrame: () => hud.updateDebug(),
  }, draw, tools));
  hud.bind(app);

  app.requestDraw();
}

void main();
