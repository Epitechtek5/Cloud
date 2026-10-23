export type PlatformKind = 'activity' | 'web';

/** Inside a Discord Activity the iframe URL always carries `frame_id`. */
export function detectPlatform(search: string = globalThis.location?.search ?? ''): PlatformKind {
  return new URLSearchParams(search).has('frame_id') ? 'activity' : 'web';
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
 */
export function activityMappings(apiBase: string, extraHosts: Record<string, string> = {}): UrlMapping[] {
  return [
    { prefix: '/api', target: new URL(apiBase).host },
    ...Object.entries(extraHosts).map(([prefix, target]) => ({ prefix, target })),
  ];
}

/** Google hosts the Firebase SDK talks to (Firestore stream + custom-token sign-in). */
export const FIREBASE_HOSTS: Record<string, string> = {
  '/firestore': 'firestore.googleapis.com',
  '/identitytoolkit': 'identitytoolkit.googleapis.com',
  '/securetoken': 'securetoken.googleapis.com',
};
