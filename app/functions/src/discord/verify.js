// Ed25519 verification of Discord interaction requests.
//
// Discord signs `timestamp + raw body` with the application's private key and
// sends the signature in X-Signature-Ed25519 (hex) and the timestamp in
// X-Signature-Timestamp. The check must run on the RAW body: re-serializing a
// parsed JSON body changes the bytes and breaks the signature.
import { createPublicKey, verify } from "node:crypto";

// DER prefix of an Ed25519 SubjectPublicKeyInfo: node:crypto needs SPKI, Discord
// gives the raw 32-byte key in hex.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const HEX = /^[\da-f]+$/i;

/** KeyObject from the hex public key shown in the Discord developer portal. */
export function publicKeyFromHex(hex) {
  const trimmed = String(hex ?? "").trim();
  if (trimmed.length !== 64 || !HEX.test(trimmed)) throw new Error("the Discord public key must be 64 hex characters");
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(trimmed, "hex")]),
    format: "der",
    type: "spki",
  });
}

/**
 * @param {import("node:crypto").KeyObject} publicKey
 * @param {{ signature?: string, timestamp?: string, rawBody?: Buffer|string, now?: number, maxAgeSeconds?: number }} input
 * @returns {boolean} true only for a valid, fresh signature
 */
export function verifyDiscordRequest(publicKey, { signature, timestamp, rawBody, now = Date.now(), maxAgeSeconds = 300 }) {
  if (typeof signature !== "string" || signature.length !== 128 || !HEX.test(signature)) return false;
  if (typeof timestamp !== "string" || !/^\d{1,12}$/.test(timestamp)) return false;
  if (rawBody === undefined || rawBody === null) return false;
  // Replay window: Discord sends the current time, an old signed request is refused.
  if (Math.abs(now / 1000 - Number(timestamp)) > maxAgeSeconds) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  return verify(null, Buffer.concat([Buffer.from(timestamp, "utf8"), body]), publicKey, Buffer.from(signature, "hex"));
}
