// Tests of infra/serverless/firestore.rules against the Firestore emulator.
// Run with `npm test` (starts the emulator, runs these tests, stops it).
//
// A "browser" here is a Firebase SDK client signed in like the front, with a
// custom token whose uid is the Discord id. The workers are simulated with
// withSecurityRulesDisabled, which is what IAM access amounts to: the rules do
// not apply to the server SDK.
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  setLogLevel,
  updateDoc,
  where,
} from 'firebase/firestore';

const ALICE = '111111111111111111';
const BOB = '222222222222222222';

let env;

// Discord login: firebase.sign_in_provider is "custom" (default of the mock token).
const browser = (uid) => env.authenticatedContext(uid).firestore();
const anonymous = () => env.unauthenticatedContext().firestore();

before(async () => {
  // Every denied write is otherwise logged by the SDK as a warning.
  setLogLevel('silent');
  env = await initializeTestEnvironment({
    projectId: 'demo-pixel-canvas',
    firestore: {
      rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'),
    },
  });
});

after(async () => {
  await env.cleanup();
});

// What the workers would have written.
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'pixels/10_20'), {
      x: 10, y: 20, tile: '0_0', c: 0xff0000, a: ALICE, an: 'alice', t: serverTimestamp(),
    });
    await setDoc(doc(db, 'session/state'), { paused: false, updatedAt: serverTimestamp() });
    await setDoc(doc(db, 'session/other'), { secret: true });
    await setDoc(doc(db, `users/${ALICE}`), { limit: 20, used: 3, windowStart: serverTimestamp() });
    await setDoc(doc(db, `users/${BOB}`), { limit: 20, used: 0, windowStart: serverTimestamp() });
    await setDoc(doc(db, 'userEvents/e1'), {
      uid: ALICE, type: 'rejected', reason: 'rate_limited', batchId: 'b1', pixels: [], t: serverTimestamp(),
    });
    await setDoc(doc(db, 'processedBatches/b1'), { expireAt: serverTimestamp() });
  });
});

describe('writes from a browser are always denied', () => {
  const targets = ['pixels/1_1', 'pixels/10_20', 'session/state', `users/${ALICE}`, 'userEvents/e2', 'processedBatches/b2'];

  for (const path of targets) {
    test(`signed-in owner cannot create, update or delete ${path}`, async () => {
      const db = browser(ALICE);
      await assertFails(setDoc(doc(db, path), { uid: ALICE, c: 0 }));
      await assertFails(updateDoc(doc(db, path), { c: 1 }));
      await assertFails(deleteDoc(doc(db, path)));
    });

    test(`anonymous caller cannot write ${path}`, async () => {
      await assertFails(setDoc(doc(anonymous(), path), { c: 0 }));
    });
  }
});

describe('pixels', () => {
  test('signed-in user reads one pixel', async () => {
    await assertSucceeds(getDoc(doc(browser(BOB), 'pixels/10_20')));
  });

  test('front tile query with a limit is allowed', async () => {
    const q = query(
      collection(browser(BOB), 'pixels'),
      where('tile', '==', '0_0'),
      where('t', '>', new Date(0)),
      orderBy('t'),
      limit(65536),
    );
    await assertSucceeds(getDocs(q));
  });

  test('query without a limit is denied', async () => {
    const q = query(collection(browser(BOB), 'pixels'), where('tile', '==', '0_0'));
    await assertFails(getDocs(q));
  });

  test('query above the tile size is denied', async () => {
    await assertFails(getDocs(query(collection(browser(BOB), 'pixels'), limit(65537))));
  });

  test('anonymous caller reads nothing', async () => {
    await assertFails(getDoc(doc(anonymous(), 'pixels/10_20')));
  });

  test('other Firebase sign-in methods are refused (anonymous auth, email...)', async () => {
    const db = env.authenticatedContext(BOB, { firebase: { sign_in_provider: 'anonymous', identities: {} } }).firestore();
    await assertFails(getDoc(doc(db, 'pixels/10_20')));
  });
});

describe('session', () => {
  test('signed-in user reads session/state', async () => {
    await assertSucceeds(getDoc(doc(browser(BOB), 'session/state')));
  });

  test('other session documents and listing are denied', async () => {
    await assertFails(getDoc(doc(browser(BOB), 'session/other')));
    await assertFails(getDocs(collection(browser(BOB), 'session')));
  });
});

describe('users', () => {
  test('a user reads its own quota', async () => {
    await assertSucceeds(getDoc(doc(browser(ALICE), `users/${ALICE}`)));
  });

  test('a user cannot read the quota of someone else, nor list users', async () => {
    await assertFails(getDoc(doc(browser(ALICE), `users/${BOB}`)));
    await assertFails(getDocs(collection(browser(ALICE), 'users')));
  });
});

describe('userEvents', () => {
  test('a user listens to its own rejected pixels', async () => {
    const db = browser(ALICE);
    const q = query(collection(db, 'userEvents'), where('uid', '==', ALICE), where('t', '>', new Date(0)));
    await assertSucceeds(getDocs(q));
    await assertSucceeds(getDoc(doc(db, 'userEvents/e1')));
  });

  test('a user cannot read the events of someone else', async () => {
    const db = browser(BOB);
    await assertFails(getDoc(doc(db, 'userEvents/e1')));
    await assertFails(getDocs(query(collection(db, 'userEvents'), where('uid', '==', ALICE))));
    await assertFails(getDocs(collection(db, 'userEvents')));
  });
});

describe('collections without a rule', () => {
  test('processedBatches is invisible to browsers', async () => {
    await assertFails(getDoc(doc(browser(ALICE), 'processedBatches/b1')));
    await assertFails(getDocs(collection(browser(ALICE), 'processedBatches')));
  });
});
