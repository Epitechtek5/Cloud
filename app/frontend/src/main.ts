import './style.css';
import { createAuth } from './auth';
import type { AuthProvider, Session } from './auth/types';
import { createBackend } from './backend';
import { CanvasApp } from './canvas/canvasApp';
import type { Backend } from './contract';
import { DrawController } from './draw/drawController';
import { detectPlatform } from './platform/context';
import { loadRuntimeConfig } from './runtimeConfig';
import { Hud } from './ui/hud';
import { addUserBadge, showLogin, showMessage } from './ui/screens';
import { Toolbar } from './ui/toolbar';
import { ToolState } from './ui/toolState';

async function main(): Promise<void> {
  const root = document.getElementById('app')!;
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const platform = detectPlatform();

  const stop = showMessage(root, platform === 'activity' ? 'Connecting to Discord…' : 'Loading…');
  let auth: AuthProvider;
  try {
    const rc = __BACKEND__ === 'mock' ? undefined : await loadRuntimeConfig();
    auth = await createAuth(platform, rc);
  } catch (e) {
    stop();
    showMessage(root, e instanceof Error ? e.message : 'Unexpected error', 'error');
    return;
  }
  let session: Session | null;
  try {
    session = await auth.restore();
  } catch (e) {
    stop();
    const msg = e instanceof Error ? e.message : 'Unexpected error';
    // In the browser every auth failure is recoverable by logging in again; in an Activity it is fatal.
    if (platform === 'web') showLogin(root, () => auth.login(), msg);
    else showMessage(root, msg, 'error');
    return;
  }
  stop();
  if (!session) {
    showLogin(root, () => auth.login());
    return;
  }

  let backend: Backend;
  try {
    backend = await createBackend(auth);
  } catch (e) {
    showMessage(root, e instanceof Error ? e.message : 'Unexpected error', 'error');
    return;
  }
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
  addUserBadge(
    root.querySelector('.bar'),
    session.user.username,
    // Activities have no logout: the Discord session is the identity. In the browser the session
    // only lives in memory, so a reload is the logout (Discord remembers the consent, see docs).
    platform === 'web' ? () => location.reload() : undefined,
  );

  app.requestDraw();
}

void main();
