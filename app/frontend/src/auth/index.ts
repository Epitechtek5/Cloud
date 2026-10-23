import { lateFetch } from '../net';
import { activityMappings, FIREBASE_HOSTS, type PlatformKind } from '../platform/context';
import type { RuntimeConfig } from '../runtimeConfig';
import { ActivityAuth } from './activity';
import type { AuthProvider } from './types';
import { WebAuth } from './web';

export async function createAuth(platform: PlatformKind, rc?: RuntimeConfig): Promise<AuthProvider> {
  if (__BACKEND__ === 'mock') {
    // Constant condition: the mock is tree-shaken out of real builds.
    const { MockAuth } = await import('./mock');
    return new MockAuth();
  }
  if (!rc) throw new Error('Runtime config is required');
  // The client id is per environment (one Discord application each), so it comes from /config.json.
  const clientId = rc.discordClientId;
  if (platform === 'activity') {
    return new ActivityAuth({ clientId, apiBase: rc.apiBase, mappings: activityMappings(rc.apiBase, FIREBASE_HOSTS), fetch: lateFetch });
  }
  return new WebAuth({
    clientId,
    apiBase: rc.apiBase,
    fetch: lateFetch,
    storage: sessionStorage,
    get href() {
      return location.href;
    },
    replaceUrl: (u) => history.replaceState(null, '', u),
    redirect: (u) => location.assign(u),
  });
}
