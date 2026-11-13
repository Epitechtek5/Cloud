import { test } from "node:test";
import assert from "node:assert/strict";
import { publicKeyFromHex, verifyDiscordRequest } from "../../src/discord/verify.js";
import { discordKeys } from "./helpers.js";

const keys = discordKeys();
const key = publicKeyFromHex(keys.publicHex);
const now = 1_800_000_000_000;
const ts = String(now / 1000);
const body = '{"type":1}';

test("accepts a valid signature over the raw body", () => {
  assert.equal(verifyDiscordRequest(key, { signature: keys.sign(ts, body), timestamp: ts, rawBody: Buffer.from(body), now }), true);
  assert.equal(verifyDiscordRequest(key, { signature: keys.sign(ts, body), timestamp: ts, rawBody: body, now }), true);
});

test("rejects a tampered body, timestamp or signature", () => {
  const signature = keys.sign(ts, body);
  assert.equal(verifyDiscordRequest(key, { signature, timestamp: ts, rawBody: '{"type": 1}', now }), false);
  assert.equal(verifyDiscordRequest(key, { signature, timestamp: String(Number(ts) + 1), rawBody: body, now }), false);
  const other = discordKeys();
  assert.equal(verifyDiscordRequest(key, { signature: other.sign(ts, body), timestamp: ts, rawBody: body, now }), false);
});

test("rejects missing or malformed headers and body", () => {
  const signature = keys.sign(ts, body);
  for (const input of [
    { timestamp: ts, rawBody: body },
    { signature: "zz".repeat(64), timestamp: ts, rawBody: body },
    { signature: "ab", timestamp: ts, rawBody: body },
    { signature, rawBody: body },
    { signature, timestamp: "abc", rawBody: body },
    { signature, timestamp: ts },
    { signature, timestamp: ts, rawBody: null },
  ])
    assert.equal(verifyDiscordRequest(key, { ...input, now }), false, JSON.stringify(input));
});

test("rejects a replayed (old) or future request", () => {
  const old = String(now / 1000 - 301);
  assert.equal(verifyDiscordRequest(key, { signature: keys.sign(old, body), timestamp: old, rawBody: body, now }), false);
  const future = String(now / 1000 + 301);
  assert.equal(verifyDiscordRequest(key, { signature: keys.sign(future, body), timestamp: future, rawBody: body, now }), false);
});

test("needs a 64 hex characters public key", () => {
  assert.throws(() => publicKeyFromHex("abc"), /64 hex/);
  assert.throws(() => publicKeyFromHex("g".repeat(64)), /64 hex/);
  assert.throws(() => publicKeyFromHex(undefined), /64 hex/);
  assert.ok(publicKeyFromHex(` ${keys.publicHex}\n`));
});
