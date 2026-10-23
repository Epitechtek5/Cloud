export type PlatformKind = 'activity' | 'web';

const inIframe = (): boolean => typeof window !== 'undefined' && window.parent !== window;

/**
 * Inside a Discord Activity the page runs in an iframe whose URL carries `frame_id`.
 * Both conditions are required: a plain browser tab that happens to have `?frame_id=` must
 * stay in web mode, otherwise it would wait forever for a Discord handshake that never comes.
 */
export function detectPlatform(search: string = globalThis.location?.search ?? '', framed: boolean = inIframe()): PlatformKind {
  return framed && new URLSearchParams(search).has('frame_id') ? 'activity' : 'web';
}

export interface UrlMapping {
  prefix: string;
  target: string;
}

/**
 * Inside an Activity the CSP only allows the Discord proxy, so every external host the
 * front talks to needs a URL mapping. These must match, one for one, the mappings set in
 * the Developer Portal (Activities > URL Mappings); see docs/discord-activity.md.
 * `patchUrlMappings` then rewrites fetch/XHR/WebSocket calls to the proxy automatically.
 *
 * The target keeps the path of `apiBase` (the SDK strips it from the rewritten URL), so
 * `https://gw.example/v1` maps `/api` to `gw.example/v1`. A same-origin `apiBase` (`/api`)
 * is already covered by the `/` mapping and needs no entry.
 */
export function activityMappings(apiBase: string, extraHosts: Record<string, string> = {}): UrlMapping[] {
  const api: UrlMapping[] = [];
  if (!apiBase.startsWith('/')) {
    const u = new URL(apiBase);
    api.push({ prefix: '/api', target: u.host + u.pathname.replace(/\/+$/, '') });
  }
  return [...api, ...Object.entries(extraHosts).map(([prefix, target]) => ({ prefix, target }))];
}

/** Google hosts the Firebase SDK talks to (Firestore stream + custom-token sign-in). */
export const FIREBASE_HOSTS: Record<string, string> = {
  '/firestore': 'firestore.googleapis.com',
  '/identitytoolkit': 'identitytoolkit.googleapis.com',
  '/securetoken': 'securetoken.googleapis.com',
};
