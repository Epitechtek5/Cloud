import type { AuthProvider } from '../auth/types';
import type { Backend } from '../contract';
import type { RuntimeConfig } from '../runtimeConfig';

export async function createBackend(auth: AuthProvider, rc?: RuntimeConfig): Promise<Backend> {
  if (__BACKEND__ === 'mock') {
    // Dynamic import + constant condition: the mock is tree-shaken out of dev/prd builds.
    const { createMockBackend } = await import('./mock');
    return createMockBackend();
  }
  if (!rc) throw new Error('Runtime config is required');
  // Loaded on demand: the Firebase SDK is only needed once logged in.
  const { createGcpBackend } = await import('./gcp');
  return createGcpBackend(auth, rc);
}
