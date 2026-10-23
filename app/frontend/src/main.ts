import './style.css';
import { createAuth } from './auth';
import type { AuthProvider, Session } from './auth/types';
import { createBackend } from './backend';
import { CanvasApp } from './canvas/canvasApp';
import type { Backend } from './contract';
import { detectPlatform } from './platform/context';
import { loadRuntimeConfig } from './runtimeConfig';
import { Hud } from './ui/hud';
import { addUserBadge, showLogin, showMessage } from './ui/screens';

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
    if (platform === 'web') showLogin(root, () => void auth.login(), msg);
    else showMessage(root, msg, 'error');
    return;
  }
  stop();
  if (!session) {
    showLogin(root, () => void auth.login());
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
  const app = new CanvasApp(canvas, backend, {
    onSelect: (p) => void hud.showPixel(p),
    onHover: (p) => hud.setHover(p),
    onViewportChange: () => {},
    onFrame: () => hud.updateDebug(),
  });
  hud.bind(app);
  addUserBadge(
    root.querySelector('.bar'),
    session.user.username,
    // Activities have no logout: the Discord session is the identity.
    platform === 'web'
      ? () => {
          auth.logout();
          location.reload();
        }
      : undefined,
  );

  app.requestDraw();
}

void main();
