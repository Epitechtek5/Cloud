// Configuration of the snapshot functions (infra/serverless/snapshots.tf).

function intIn(env, name, min, max, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer ${min}..${max}`);
  return n;
}

export function loadSnapshotWorkerConfig(env = process.env) {
  if (!env.SNAPSHOTS_BUCKET) throw new Error("missing SNAPSHOTS_BUCKET");
  return {
    bucket: env.SNAPSHOTS_BUCKET,
    // ~40 bytes per pixel in memory: 2 million fit in the 512 MiB instance.
    maxPixels: intIn(env, "MAX_SNAPSHOT_PIXELS", 1, 10_000_000, 2_000_000),
  };
}

export function loadNotifierConfig(env = process.env) {
  // V4 signed URLs live at most 7 days.
  return { ttlSeconds: intIn(env, "SIGNED_URL_TTL_SECONDS", 60, 604_800, 3600) };
}
