// Secret Manager access with an in-memory cache per instance.
//
// A function instance serves many requests: the secret is read once (the
// promise is cached, so concurrent cold requests share one call), then reused.
// A failed read is not cached, the next call retries.

async function defaultClient() {
  const { SecretManagerServiceClient } = await import("@google-cloud/secret-manager");
  return new SecretManagerServiceClient();
}

/**
 * @param {object} [options]
 * @param {object} [options.client]  a SecretManagerServiceClient (tests inject a fake one)
 * @param {string} [options.projectId]  for short names (env GOOGLE_CLOUD_PROJECT by default)
 * @param {number} [options.ttlMs]  cache lifetime, forever by default (versions are pinned or "latest")
 */
export function createSecretReader({ client, projectId, ttlMs = Infinity } = {}) {
  let clientPromise = client ? Promise.resolve(client) : undefined;
  const cache = new Map();

  function resourceName(name, version) {
    if (name.startsWith("projects/")) return name.includes("/versions/") ? name : `${name}/versions/${version}`;
    const project = projectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCP_PROJECT;
    if (!project) throw new Error(`no project to resolve secret ${name}: set GOOGLE_CLOUD_PROJECT`);
    return `projects/${project}/secrets/${name}/versions/${version}`;
  }

  async function read(resource) {
    clientPromise ??= defaultClient();
    const [response] = await (await clientPromise).accessSecretVersion({ name: resource });
    return Buffer.from(response.payload.data).toString("utf8");
  }

  return {
    /** Value of a secret (short name or full resource name), as a UTF-8 string. */
    async get(name, { version = "latest" } = {}) {
      const resource = resourceName(name, version);
      const cached = cache.get(resource);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const value = read(resource);
      cache.set(resource, { value, expiresAt: Date.now() + ttlMs });
      value.catch(() => cache.delete(resource));
      return value;
    },
    /** Drops the cache (e.g. after a key rotation detected by a failed verification). */
    clear: () => cache.clear(),
  };
}
