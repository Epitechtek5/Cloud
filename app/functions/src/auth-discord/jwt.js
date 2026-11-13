// Our own session JWT (RFC 7519), signed with an asymmetric key so that the
// API Gateway can verify it with the public half only (x-google-jwks_uri):
// ES256 for an EC P-256 key, RS256 for an RSA key. No dependency, node:crypto
// only. The private key is the `jwt-signing-key` secret (PEM, PKCS#8 or SEC1).

import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";

const b64url = (input) => Buffer.from(input).toString("base64url");

/** RFC 7638 thumbprint: SHA-256 of the required members, in lexicographic order. */
function thumbprint(jwk) {
  const members = jwk.kty === "EC" ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y } : { e: jwk.e, kty: jwk.kty, n: jwk.n };
  return createHash("sha256").update(JSON.stringify(members)).digest("base64url");
}

export function loadSigningKey(pem) {
  const key = createPrivateKey(pem);
  let alg;
  if (key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") alg = "ES256";
  else if (key.asymmetricKeyType === "rsa" && key.asymmetricKeyDetails?.modulusLength >= 2048) alg = "RS256";
  else throw new Error("JWT_SIGNING_KEY must be an EC P-256 or RSA (2048+) private key");

  const publicJwk = createPublicKey(key).export({ format: "jwk" });
  const kid = thumbprint(publicJwk);
  return { key, alg, kid, publicJwk: { ...publicJwk, kid, alg, use: "sig" } };
}

export function signJwt(signingKey, claims) {
  const header = { alg: signingKey.alg, typ: "JWT", kid: signingKey.kid };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  // JWS ES256 wants the raw r||s signature, not the DER encoding (RFC 7518 §3.4).
  const options = signingKey.alg === "ES256" ? { key: signingKey.key, dsaEncoding: "ieee-p1363" } : signingKey.key;
  return `${input}.${sign("sha256", Buffer.from(input), options).toString("base64url")}`;
}

/** Public key set served on GET, for the gateway (contains no private member). */
export function jwks(signingKey) {
  return { keys: [signingKey.publicJwk] };
}
