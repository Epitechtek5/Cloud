import type { PixelDelta, RealtimeChannel, SessionState, Unsubscribe, UserEvent } from '../../contract';
import { pixelFromDoc, quotaFromDoc, rejectionFromDoc, sessionFromDoc } from './mappers';

export type Doc = Record<string, unknown> | undefined;

/**
 * The few Firestore reads the front needs (everything read-only, see infra/serverless/firestore.rules).
 * A narrow interface keeps the channel logic testable without the SDK; `firestoreStore.ts` is the real one.
 */
export interface RealtimeStore {
  /** Pixels of `tile` ("tx_ty") with `t > sinceMs`: the existing ones first, then each change. */
  watchTile(tile: string, sinceMs: number, onDocs: (docs: Doc[]) => void, onError: (e: unknown) => void): Unsubscribe;
  /** `session/state`; `undefined` while the document does not exist. */
  watchSession(onDoc: (d: Doc) => void, onError: (e: unknown) => void): Unsubscribe;
  /** `users/{uid}`; `undefined` until the user drew once. */
  watchUser(uid: string, onDoc: (d: Doc) => void, onError: (e: unknown) => void): Unsubscribe;
  /** New `userEvents` of `uid` created after `afterMs`. */
  watchRejections(uid: string, afterMs: number, onDocs: (docs: Doc[]) => void, onError: (e: unknown) => void): Unsubscribe;
}

export interface ChannelDeps {
  store: RealtimeStore;
  /** Discord id = Firebase uid. */
  uid: string;
  now?: () => number;
  /** Listener failures (permission denied, missing index, network) must be visible, never swallowed. */
  onError?: (scope: string, e: unknown) => void;
}

export function createRealtimeChannel(d: ChannelDeps): RealtimeChannel {
  const now = d.now ?? Date.now;
  const fail = d.onError ?? ((scope, e) => console.error(`[realtime] ${scope}`, e));
  // Rejections older than the page are not ours to show (they belong to a previous session).
  const openedAt = now();

  return {
    subscribeTile(tx, ty, onDeltas, { since }): Unsubscribe {
      return d.store.watchTile(
        `${tx}_${ty}`,
        since,
        (docs) => {
          const deltas = docs.map(pixelFromDoc).filter((p): p is PixelDelta => p !== null);
          if (deltas.length > 0) onDeltas(deltas);
        },
        (e) => fail(`tile ${tx},${ty}`, e),
      );
    },

    subscribeSession(onState: (s: SessionState) => void): Unsubscribe {
      return d.store.watchSession((doc) => onState(sessionFromDoc(doc)), (e) => fail('session/state', e));
    },

    subscribeUserEvents(onEvent: (e: UserEvent) => void): Unsubscribe {
      let resetTimer: ReturnType<typeof setTimeout> | undefined;
      const stopUser = d.store.watchUser(
        d.uid,
        (doc) => {
          clearTimeout(resetTimer);
          const q = quotaFromDoc(doc, now());
          if (!q) return;
          onEvent(q.event);
          // The stored counter is only rewritten when the user draws: announce the full quota when the window ends
          // (a single timeout, not polling).
          if (q.resetAt !== null && q.event.type === 'quota') {
            const full: UserEvent = { type: 'quota', remaining: q.event.limit, limit: q.event.limit };
            resetTimer = setTimeout(() => onEvent(full), Math.max(0, q.resetAt - now()));
          }
        },
        (e) => fail(`users/${d.uid}`, e),
      );
      const stopRejections = d.store.watchRejections(
        d.uid,
        openedAt,
        (docs) => {
          for (const doc of docs) {
            const ev = rejectionFromDoc(doc);
            if (ev) onEvent(ev);
          }
        },
        (e) => fail('userEvents', e),
      );
      return () => {
        clearTimeout(resetTimer);
        stopUser();
        stopRejections();
      };
    },
  };
}
