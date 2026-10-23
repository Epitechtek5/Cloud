import type { AuthProvider } from '../auth/types';
import type { Backend } from '../contract';

export async function createBackend(_auth: AuthProvider): Promise<Backend> {
  if (__BACKEND__ === 'mock') {
    // Dynamic import + constant condition: the mock is tree-shaken out of dev/prd builds.
    const { createMockBackend } = await import('./mock');
    return createMockBackend();
  }
  // Gateway client (Bearer = await auth.token()) + Firestore listeners: next PR.
  throw new Error('GCP backend not implemented yet');
}
