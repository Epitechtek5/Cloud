import { test } from "node:test";
import assert from "node:assert/strict";
import { createInteractionClient, DiscordApiError } from "../../src/lib/discordWebhook.js";

const interaction = { id: "1200000000000000001", applicationId: "1100000000000000001", token: "tok/with?chars" };

function fakeFetch(responses = [{ status: 200, body: { id: "m1" } }]) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { status: 200, body: {} };
    if (next.throws) throw next.throws;
    return new Response(next.status === 204 ? null : JSON.stringify(next.body ?? {}), { status: next.status });
  };
  return { fn, calls };
}

test("edits the original response as JSON, without pinging anyone", async () => {
  const { fn, calls } = fakeFetch();
  const client = createInteractionClient({ fetch: fn, baseUrl: "https://discord.test" });
  const out = await client.editOriginal(interaction, { content: "done" });
  assert.deepEqual(out, { id: "m1" });
  assert.equal(calls[0].init.method, "PATCH");
  assert.equal(calls[0].url, "https://discord.test/webhooks/1100000000000000001/tok%2Fwith%3Fchars/messages/@original");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), { content: "done", allowed_mentions: { parse: [] } });
});

test("posts a follow-up with flags", async () => {
  const { fn, calls } = fakeFetch([{ status: 204 }]);
  const client = createInteractionClient({ fetch: fn, baseUrl: "https://discord.test" });
  assert.equal(await client.followUp(interaction, { content: "hi", flags: 64 }), null);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].url, "https://discord.test/webhooks/1100000000000000001/tok%2Fwith%3Fchars");
  assert.equal(JSON.parse(calls[0].init.body).flags, 64);
});

test("sends files as multipart with payload_json and attachments", async () => {
  const { fn, calls } = fakeFetch();
  const client = createInteractionClient({ fetch: fn, baseUrl: "https://discord.test" });
  const data = Buffer.from([1, 2, 3]);
  await client.editOriginal(interaction, { content: "img", files: [{ name: "a.png", contentType: "image/png", data, description: "A" }] });
  const form = calls[0].init.body;
  assert.ok(form instanceof FormData);
  const payload = JSON.parse(form.get("payload_json"));
  assert.deepEqual(payload.attachments, [{ id: 0, filename: "a.png", description: "A" }]);
  const file = form.get("files[0]");
  assert.equal(file.name, "a.png");
  assert.equal(file.type, "image/png");
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3]);
});

test("errors say whether a retry can help, and never carry the token", async () => {
  const cases = [
    { status: 404, body: { code: 10015 }, retryable: false, reason: "10015" },
    { status: 429, body: {}, retryable: true },
    { status: 502, body: {}, retryable: true },
  ];
  for (const c of cases) {
    const { fn } = fakeFetch([c]);
    const client = createInteractionClient({ fetch: fn, baseUrl: "https://discord.test" });
    const err = await client.editOriginal(interaction, { content: "x" }).catch((e) => e);
    assert.ok(err instanceof DiscordApiError);
    assert.equal(err.status, c.status);
    assert.equal(err.retryable, c.retryable);
    if (c.reason) assert.equal(err.reason, c.reason);
    assert.ok(!err.message.includes("tok"));
  }
  const { fn } = fakeFetch([{ throws: new Error("ECONNRESET tok") }]);
  const err = await createInteractionClient({ fetch: fn }).followUp(interaction, { content: "x" }).catch((e) => e);
  assert.equal(err.status, 0);
  assert.equal(err.retryable, true);
  assert.ok(!err.message.includes("tok"));
});
