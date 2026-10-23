import { activityMappings, FIREBASE_HOSTS, type PlatformKind } from '../platform/context';
import type { RuntimeConfig } from '../runtimeConfig';
import { config } from '../config';
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
  const clientId = config.discordClientId;
  // The browser's fetch must be called as a method of window; bind it before handing it over.
  const fetchFn = globalThis.fetch.bind(globalThis);
  if (platform === 'activity') {
    return new ActivityAuth({ clientId, apiBase: rc.apiBase, mappings: activityMappings(rc.apiBase, FIREBASE_HOSTS), fetch: fetchFn });
  }
  return new WebAuth({
    clientId,
    apiBase: rc.apiBase,
    fetch: fetchFn,
    storage: sessionStorage,
    get href() {
      return location.href;
    },
    replaceUrl: (u) => history.replaceState(null, '', u),
    redirect: (u) => location.assign(u),
  });
}
