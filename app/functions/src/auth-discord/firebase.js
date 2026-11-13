// Optional Firebase custom token (uid = Discord id), used by the front for
// signInWithCustomToken() before opening its Firestore listeners. Enabled by
// FIREBASE_CUSTOM_TOKEN=true only. Signed by the function's own account like
// the session JWT (see sign.js), which is what the Admin SDK does too when it
// runs without a key file.

const AUDIENCE = "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit";

/** @param {ReturnType<import("./sign.js").createIamSigner>} signer */
export function createFirebaseSigner(signer, now = () => Date.now()) {
  return async function customToken(uid, ttlSeconds) {
    const email = await signer.email();
    const iat = Math.floor(now() / 1000);
    // Firebase accepts at most one hour; the front exchanges it right away.
    return signer.sign({ iss: email, sub: email, aud: AUDIENCE, iat, exp: iat + Math.min(ttlSeconds, 3600), uid });
  };
}
