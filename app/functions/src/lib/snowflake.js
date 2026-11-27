// Discord snowflakes encode their creation time: (id >> 22) + Discord epoch.
const DISCORD_EPOCH = 1420070400000n;

/** Creation time (epoch ms) of a Discord id, e.g. when an interaction was sent. */
export function snowflakeTime(id) {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}
