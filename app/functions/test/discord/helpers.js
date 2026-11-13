import { generateKeyPairSync, sign } from "node:crypto";

/** A throwaway Ed25519 key pair standing for the Discord application's one. */
export function discordKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // Raw 32-byte public key in hex, as shown in the developer portal.
  const publicHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  return {
    publicHex,
    sign: (timestamp, body) => sign(null, Buffer.from(timestamp + body), privateKey).toString("hex"),
  };
}

/** Minimal Express-like request/response pair, as given by the Functions Framework. */
export function signedRequest(keys, body, { timestamp = String(Math.floor(Date.now() / 1000)), signature, headers = {}, method = "POST" } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const all = {
    "x-signature-ed25519": signature ?? keys.sign(timestamp, raw),
    "x-signature-timestamp": timestamp,
    ...headers,
  };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  return {
    method,
    headers: all,
    rawBody: Buffer.from(raw),
    body: parsed,
    get: (name) => all[name.toLowerCase()],
  };
}

export function response() {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.status = (code) => ((res.statusCode = code), res);
  res.set = (name, value) => ((res.headers[name] = value), res);
  res.send = (body) => ((res.body = body), res);
  res.json = (body) => ((res.body = body), res);
  return res;
}

export const drawInteraction = {
  id: "1200000000000000001",
  application_id: "1100000000000000001",
  type: 2,
  token: "interaction-token",
  guild_id: "1000000000000000001",
  channel_id: "1000000000000000002",
  member: {
    user: { id: "123456789012345678", username: "alice", global_name: "Alice" },
    roles: ["1000000000000000003"],
    permissions: "2147483647",
  },
  data: {
    name: "draw",
    options: [
      { name: "x", type: 4, value: 10 },
      { name: "y", type: 4, value: 20 },
      { name: "color", type: 3, value: "#ff0000" },
    ],
  },
};
