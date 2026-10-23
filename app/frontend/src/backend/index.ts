import type { Backend } from '../contract';

export async function createBackend(): Promise<Backend> {
  if (__BACKEND__ === 'mock') {
    // Dynamic import + constant condition: the mock is tree-shaken out of dev/prd builds.
    const { createMockBackend } = await import('./mock');
    return createMockBackend();
  }
  // Phase 4/5: Firestore listeners + gateway client.
  throw new Error('GCP backend not implemented yet');
}
