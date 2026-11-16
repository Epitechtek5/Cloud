// Firestore emulator helpers. These tests only run under
// `npm run test:emulator` / `npm run test:ci` (firebase emulators:exec sets
// FIRESTORE_EMULATOR_HOST); plain `npm test` skips them.
import { Firestore } from "@google-cloud/firestore";

export const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
export const PROJECT = process.env.GCLOUD_PROJECT ?? "demo-pixel-canvas";
/** `test(name, emulatorOnly, fn)`: skipped, with the reason, without the emulator. */
export const emulatorOnly = { skip: EMULATOR ? false : "needs the Firestore emulator (npm run test:emulator)" };

let db;
export function emulatorDb() {
  db ??= new Firestore({ projectId: PROJECT, ignoreUndefinedProperties: true });
  return db;
}

/** Deletes every document of the emulator database. */
export async function resetEmulator() {
  const res = await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  if (!res.ok) throw new Error(`cannot reset the emulator: ${res.status}`);
}
