import { test } from "node:test";
import assert from "node:assert/strict";
import { createSecretReader } from "../../src/lib/secrets.js";

function fakeClient(values) {
  const calls = [];
  return {
    calls,
    async accessSecretVersion({ name }) {
      calls.push(name);
      const value = values[name];
      if (value instanceof Error) throw value;
      return [{ payload: { data: Buffer.from(value) } }];
    },
  };
}

const KEY = "projects/p1/secrets/discord-public-key/versions/latest";

test("reads a short name in the configured project and caches it", async () => {
  const client = fakeClient({ [KEY]: "abc" });
  const secrets = createSecretReader({ client, projectId: "p1" });
  const [a, b] = await Promise.all([secrets.get("discord-public-key"), secrets.get("discord-public-key")]);
  assert.equal(a, "abc");
  assert.equal(b, "abc");
  assert.equal(await secrets.get("discord-public-key"), "abc");
  assert.deepEqual(client.calls, [KEY]);
});

test("accepts full resource names, with or without a version", async () => {
  const pinned = "projects/p2/secrets/s/versions/3";
  const client = fakeClient({ [pinned]: "v3", "projects/p2/secrets/s/versions/latest": "latest" });
  const secrets = createSecretReader({ client });
  assert.equal(await secrets.get(pinned), "v3");
  assert.equal(await secrets.get("projects/p2/secrets/s"), "latest");
  assert.equal(await secrets.get("projects/p2/secrets/s", { version: "3" }), "v3");
});

test("does not cache a failure", async () => {
  const values = { [KEY]: new Error("unavailable") };
  const client = fakeClient(values);
  const secrets = createSecretReader({ client, projectId: "p1" });
  await assert.rejects(secrets.get("discord-public-key"), /unavailable/);
  values[KEY] = "ok";
  assert.equal(await secrets.get("discord-public-key"), "ok");
  assert.equal(client.calls.length, 2);
});

test("a failed read does not evict a newer cached read", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  let fail;
  const client = {
    calls: 0,
    async accessSecretVersion() {
      this.calls++;
      if (this.calls === 1) await new Promise((_, reject) => (fail = reject));
      return [{ payload: { data: Buffer.from("new") } }];
    },
  };
  const secrets = createSecretReader({ client, projectId: "p1", ttlMs: 1000 });
  const first = secrets.get("discord-public-key");
  t.mock.timers.tick(2000); // the pending first read expires
  assert.equal(await secrets.get("discord-public-key"), "new");
  fail(new Error("unavailable"));
  await assert.rejects(first, /unavailable/);
  assert.equal(await secrets.get("discord-public-key"), "new");
  assert.equal(client.calls, 2); // the newer entry is still cached
});

test("expires entries after ttlMs and can be cleared", async () => {
  const client = fakeClient({ [KEY]: "abc" });
  const secrets = createSecretReader({ client, projectId: "p1", ttlMs: -1 });
  await secrets.get("discord-public-key");
  await secrets.get("discord-public-key");
  assert.equal(client.calls.length, 2);

  const cached = createSecretReader({ client, projectId: "p1" });
  await cached.get("discord-public-key");
  cached.clear();
  await cached.get("discord-public-key");
  assert.equal(client.calls.length, 4);
});

test("fails clearly without a project for a short name", async (t) => {
  const saved = { a: process.env.GOOGLE_CLOUD_PROJECT, b: process.env.GCP_PROJECT };
  delete process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.GCP_PROJECT;
  t.after(() => {
    if (saved.a !== undefined) process.env.GOOGLE_CLOUD_PROJECT = saved.a;
    if (saved.b !== undefined) process.env.GCP_PROJECT = saved.b;
  });
  const secrets = createSecretReader({ client: fakeClient({}) });
  await assert.rejects(secrets.get("x"), /GOOGLE_CLOUD_PROJECT/);
});
