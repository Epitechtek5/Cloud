// Configuration of the draw worker (infra/serverless/draw_worker.tf).

function intIn(env, name, min, max, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer ${min}..${max}`);
  return n;
}

export function loadDrawConfig(env = process.env) {
  return {
    // Subject 3.3: 20 pixels per minute by default, `/admin ratelimit` overrides it per user.
    defaultLimit: intIn(env, "DEFAULT_RATE_LIMIT", 0, 100_000, 20),
    windowMs: intIn(env, "RATE_WINDOW_SECONDS", 1, 3600, 60) * 1000,
  };
}
