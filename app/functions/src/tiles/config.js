// Configuration of the tile functions (infra/serverless/tiles.tf).

function intIn(env, name, min, max, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer ${min}..${max}`);
  return n;
}

export function tilesBucketName(env = process.env) {
  if (!env.TILES_BUCKET) throw new Error("missing TILES_BUCKET");
  return env.TILES_BUCKET;
}

export function loadRendererConfig(env = process.env) {
  return {
    bucket: tilesBucketName(env),
    // A tile is rendered at most once per interval while messages keep coming (the "debounce" of a brush burst).
    minIntervalMs: intIn(env, "RENDER_MIN_INTERVAL_MS", 0, 60_000, 1500),
    // Time one message may spend rendering: below the function timeout and the ack deadline of pixel.processed.
    budgetMs: intIn(env, "RENDER_BUDGET_MS", 1000, 300_000, 20_000),
    // A message can touch up to 256 tiles: how many are rendered at once.
    concurrency: intIn(env, "RENDER_CONCURRENCY", 1, 32, 8),
    // How long a renderer owns a tile without checking in (a dead one is replaced after that).
    leaseMs: intIn(env, "RENDER_LEASE_MS", 1000, 300_000, 25_000),
  };
}

export function loadReaderConfig(env = process.env) {
  return {
    bucket: tilesBucketName(env),
    // docs/frontend-contract.md §2: `Cache-Control: public, max-age=60`.
    maxAgeSeconds: intIn(env, "TILE_MAX_AGE_SECONDS", 0, 3600, 60),
    // A 404 is cached shorter: a tile painted for the first time should not look empty for long.
    missingMaxAgeSeconds: intIn(env, "TILE_MISSING_MAX_AGE_SECONDS", 0, 3600, 30),
  };
}
