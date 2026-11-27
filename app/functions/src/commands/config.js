// Configuration of the command worker, from the environment set by Terraform
// (infra/serverless/command_worker.tf).
//
// Admins are a Discord role id list and/or a user id allow-list. They are
// public ids, not secrets, so they live in <env>.tfvars. Empty lists mean
// nobody is admin: the worker fails closed.

const SNOWFLAKE = /^\d{5,25}$/;

/** A list of Discord ids from a JSON array or a comma-separated string. */
export function parseIds(raw, name) {
  if (raw === undefined || raw.trim() === "") return new Set();
  let list;
  try {
    list = /^[[{]/.test(raw.trim()) ? JSON.parse(raw) : raw.split(",");
  } catch {
    throw new Error(`${name} must be a JSON array or a comma-separated list of Discord ids`);
  }
  if (!Array.isArray(list)) throw new Error(`${name} must be a list`);
  const ids = list.map((id) => String(id).trim()).filter((id) => id !== "");
  for (const id of ids) if (!SNOWFLAKE.test(id)) throw new Error(`${name} must only hold Discord ids`);
  return new Set(ids);
}

function intIn(raw, name, min, max, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer ${min}..${max}`);
  return n;
}

export function loadCommandConfig(env = process.env) {
  return {
    adminRoleIds: parseIds(env.ADMIN_ROLE_IDS, "ADMIN_ROLE_IDS"),
    adminUserIds: parseIds(env.ADMIN_USER_IDS, "ADMIN_USER_IDS"),
    // Link to the web canvas in the /get answer (empty: no link).
    appUrl: env.APP_URL ?? "",
    // Side of the square rendered by /get when the user gives none, and its bounds.
    getDefaultSize: intIn(env.GET_DEFAULT_SIZE, "GET_DEFAULT_SIZE", 16, 512, 128),
  };
}
