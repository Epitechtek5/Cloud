// Firestore client of the workers (server SDK, the function's own service
// account: IAM decides, the security rules do not apply). Loaded lazily so
// that functions which never touch Firestore (proxies) do not pay for it.
//
// FIRESTORE_EMULATOR_HOST, when set, sends every call to the emulator (tests).

let clientPromise;

/** The shared Firestore client of this instance. */
export async function getFirestore() {
  clientPromise ??= import("@google-cloud/firestore")
    .then(({ Firestore }) => new Firestore({ ignoreUndefinedProperties: true }))
    .catch((error) => {
      clientPromise = undefined; // a failed import is retried on the next call
      throw error;
    });
  return clientPromise;
}

/** `FieldValue` and `Timestamp` of the SDK, for the code that builds documents. */
export async function firestoreTypes() {
  const { FieldValue, Timestamp } = await import("@google-cloud/firestore");
  return { FieldValue, Timestamp };
}

/** Epoch ms of a Firestore Timestamp (or anything with toMillis), null otherwise. */
export function toMillis(value) {
  return typeof value?.toMillis === "function" ? value.toMillis() : null;
}
