#!/usr/bin/env node
// Registers the slash commands of commands.json on a Discord application.
//
// Idempotent: the definitions are compared with the registered ones and only
// written (bulk overwrite, PUT) when they differ. Guild commands by default
// (visible at once in the dev/prd guild), global ones without --guild-id.
//
// The bot token comes from DISCORD_BOT_TOKEN (read from Secret Manager by the
// pipeline) and is never printed.
//
// Usage: DISCORD_BOT_TOKEN=... node commands/register.js --application-id <id> [--guild-id <id>] [--dry-run]
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const API = "https://discord.com/api/v10";
const NAME = /^[-_\p{L}\p{N}]{1,32}$/u;
const SNOWFLAKE = /^\d{5,25}$/;
const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;

/** Checks the definitions against Discord's limits; returns the list of problems. */
export function validateCommands(commands) {
  const errors = [];
  if (!Array.isArray(commands) || commands.length === 0) return ["commands must be a non-empty array"];
  const names = new Set();

  const checkOption = (option, path) => {
    if (!NAME.test(option.name ?? "") || option.name !== option.name.toLowerCase())
      errors.push(`${path}: name must be 1-32 lowercase characters`);
    if (!option.description || option.description.length > 100) errors.push(`${path}: description must be 1-100 characters`);
    if (option.min_value !== undefined && option.max_value !== undefined && option.min_value > option.max_value)
      errors.push(`${path}: min_value > max_value`);
    const children = option.options ?? [];
    if (children.length > 25) errors.push(`${path}: at most 25 options`);
    let optionalSeen = false;
    for (const child of children) {
      const isSub = child.type === SUB_COMMAND || child.type === SUB_COMMAND_GROUP;
      if (!isSub && child.required) {
        if (optionalSeen) errors.push(`${path}.${child.name}: required options must come first`);
      } else if (!isSub) optionalSeen = true;
      checkOption(child, `${path}.${child.name}`);
    }
  };

  for (const command of commands) {
    if (names.has(command.name)) errors.push(`${command.name}: duplicate command`);
    names.add(command.name);
    checkOption(command, `/${command.name}`);
  }
  return errors;
}

// Fields Discord echoes back with defaults: compared on what we define only.
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((k) => value[k] !== undefined && value[k] !== null)
        .map((k) => [k, normalize(value[k])]),
    );
  }
  return value;
}

/** The registered commands reduced to the fields of our definitions. */
export function project(defined, registered) {
  const pick = (def, reg) => {
    if (Array.isArray(def)) {
      if (!Array.isArray(reg)) return reg;
      return def.map((d, i) => pick(d, reg.find((r) => r?.name !== undefined && r.name === d?.name) ?? reg[i]));
    }
    if (def && typeof def === "object" && reg && typeof reg === "object")
      return Object.fromEntries(Object.keys(def).map((k) => [k, pick(def[k], reg[k])]));
    return reg;
  };
  const byName = new Map(registered.map((c) => [c.name, c]));
  return defined.map((d) => pick(d, byName.get(d.name) ?? {}));
}

export function sameCommands(defined, registered) {
  if (defined.length !== registered.length) return false;
  return JSON.stringify(normalize(defined)) === JSON.stringify(normalize(project(defined, registered)));
}

async function call(fetchImpl, token, method, path, body, attempt = 0) {
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", "User-Agent": "DiscordBot (cloud-pixels, 1.0)" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429 && attempt < 3) {
    const retryAfter = Number((await res.json().catch(() => ({}))).retry_after ?? 1);
    await new Promise((r) => setTimeout(r, Math.min(retryAfter, 10) * 1000));
    return call(fetchImpl, token, method, path, body, attempt + 1);
  }
  if (!res.ok) {
    // The body explains which field Discord refused; it never contains the token.
    throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * @returns {Promise<"unchanged"|"updated"|"dry-run">}
 */
export async function registerCommands({ commands, token, applicationId, guildId, dryRun = false, fetchImpl = fetch, log = console.log }) {
  const errors = validateCommands(commands);
  if (errors.length > 0) throw new Error(`invalid command definitions:\n- ${errors.join("\n- ")}`);
  if (!SNOWFLAKE.test(applicationId ?? "")) throw new Error("--application-id must be a Discord id");
  if (guildId !== undefined && !SNOWFLAKE.test(guildId)) throw new Error("--guild-id must be a Discord id");
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not set");

  const path = guildId ? `/applications/${applicationId}/guilds/${guildId}/commands` : `/applications/${applicationId}/commands`;
  const scope = guildId ? `guild ${guildId}` : "global";
  const registered = await call(fetchImpl, token, "GET", path);
  if (sameCommands(commands, registered)) {
    log(`Commands already up to date (${scope}): ${commands.map((c) => `/${c.name}`).join(", ")}`);
    return "unchanged";
  }
  if (dryRun) {
    log(`Dry run: the ${scope} commands differ and would be overwritten`);
    return "dry-run";
  }
  const result = await call(fetchImpl, token, "PUT", path, commands);
  log(`Registered ${result.length} commands (${scope}): ${result.map((c) => `/${c.name}`).join(", ")}`);
  return "updated";
}

export async function loadCommands(file = new URL("./commands.json", import.meta.url)) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function main() {
  const { values } = parseArgs({
    options: {
      "application-id": { type: "string" },
      "guild-id": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  await registerCommands({
    commands: await loadCommands(),
    token: process.env.DISCORD_BOT_TOKEN,
    applicationId: values["application-id"],
    guildId: values["guild-id"],
    dryRun: values["dry-run"],
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
