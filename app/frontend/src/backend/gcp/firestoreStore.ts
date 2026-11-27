import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  where,
  type DocumentData,
  type Firestore,
} from 'firebase/firestore';
import type { Doc, RealtimeStore } from './realtime';

/** Largest result of a tile query: a tile holds at most 256 x 256 pixels, and the rules refuse any bigger `limit`. */
export const TILE_QUERY_LIMIT = 65_536;

const data = (d: DocumentData | undefined): Doc => d as Doc;

/** Read-only Firestore listeners (queries mirror docs/frontend-contract.md section 3 and the security rules). */
export function createFirestoreStore(db: Firestore): RealtimeStore {
  return {
    watchTile(tile, sinceMs, onDocs, onError) {
      const q = query(
        collection(db, 'pixels'),
        where('tile', '==', tile),
        where('t', '>', Timestamp.fromMillis(sinceMs)),
        orderBy('t'),
        limit(TILE_QUERY_LIMIT),
      );
      // Only added and modified documents are deltas (a repainted pixel is a modification); the first
      // snapshot lists everything newer than the raster as "added".
      return onSnapshot(
        q,
        (snap) => onDocs(snap.docChanges().filter((c) => c.type !== 'removed').map((c) => data(c.doc.data()))),
        onError,
      );
    },

    watchSession(onDoc, onError) {
      return onSnapshot(doc(db, 'session', 'state'), (snap) => onDoc(data(snap.data())), onError);
    },

    watchUser(uid, onDoc, onError) {
      return onSnapshot(doc(db, 'users', uid), (snap) => onDoc(data(snap.data())), onError);
    },

    watchRejections(uid, afterMs, onDocs, onError) {
      // The rules accept the query only if it filters on our own uid.
      const q = query(collection(db, 'userEvents'), where('uid', '==', uid), where('t', '>', Timestamp.fromMillis(afterMs)));
      return onSnapshot(
        q,
        (snap) => onDocs(snap.docChanges().filter((c) => c.type === 'added').map((c) => data(c.doc.data()))),
        onError,
      );
    },
  };
}
