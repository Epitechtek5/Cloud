import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken } from 'firebase/auth';
import { initializeFirestore } from 'firebase/firestore';
import type { AuthProvider } from '../../auth/types';
import type { Backend } from '../../contract';
import { lateFetch } from '../../net';
import type { RuntimeConfig } from '../../runtimeConfig';
import { createGatewayApi } from './api';
import { createFirestoreStore } from './firestoreStore';
import { createRealtimeChannel } from './realtime';
import { createTileSource } from './tiles';

/**
 * The real backend: API Gateway for writes and lookups, tile rasters for the first image, Firestore
 * listeners (read-only) for everything that changes. Nothing here writes to storage.
 */
export async function createGcpBackend(auth: AuthProvider, rc: RuntimeConfig): Promise<Backend> {
  const session = auth.session;
  if (!session) throw new Error('Not logged in');
  if (!session.firebaseToken) {
    throw new Error('The login service returned no Firebase token (is FIREBASE_CUSTOM_TOKEN enabled?): real time is unavailable.');
  }

  const app = initializeApp(rc.firebase);
  await signInWithCustomToken(getAuth(app), session.firebaseToken);
  // Auto-detect: inside the Discord proxy (Activity) the streaming channel may be cut, long polling then takes over.
  const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });

  return {
    tiles: createTileSource({ base: rc.tilesBase, fetch: lateFetch }),
    realtime: createRealtimeChannel({ store: createFirestoreStore(db), uid: session.user.id }),
    api: createGatewayApi({ apiBase: rc.apiBase, token: () => auth.token(), fetch: lateFetch }),
  };
}
