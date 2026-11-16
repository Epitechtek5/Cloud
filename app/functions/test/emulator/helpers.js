// Firestore emulator helpers. These tests only run under
// `npm run test:emulator` / `npm run test:ci` (firebase emulators:exec sets
// FIRESTORE_EMULATOR_HOST); plain `npm test` skips them.
import { Firestore } from "@google-cloud/firestore";

export const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
export const PROJECT = process.env.GCLOUD_PROJECT ?? "demo-pixel-canvas";
/** `test(name, emulatorOnly, fn)`: skipped, with the reason, without the emulator. */
export const emulatorOnly = { skip: EMULATOR ? false : "needs the Firestore emulator (npm run test:emulator)" };

// node --test runs the files in parallel: each file works in its own
// database of the emulator, so that one file's reset never wipes another's data.
const databases = new Map();

/** Firestore client on the database `name` of the emulator (one per test file). */
export function emulatorDb(name) {
  if (!databases.has(name)) databases.set(name, new Firestore({ projectId: PROJECT, databaseId: name, ignoreUndefinedProperties: true }));
  return databases.get(name);
}

/** Deletes every document of the emulator database `name`. */
export async function resetEmulator(name) {
  const res = await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT}/databases/${name}/documents`, { method: "DELETE" });
  if (!res.ok) throw new Error(`cannot reset the emulator: ${res.status}`);
}
