// Valid payloads of every event type.
export const interaction = { id: "1200000000000000001", applicationId: "1100000000000000001", token: "tok" };
export const user = { id: "123456789012345678", name: "alice" };

export const valid = {
  "discord.command": {
    interaction,
    command: "draw",
    subcommand: null,
    options: { x: 1, y: 2, color: "#ff0000" },
    guildId: "1000000000000000001",
    channelId: "1000000000000000002",
    user,
    memberRoles: ["1000000000000000003"],
    memberPermissions: "8",
  },
  "pixel.draw": {
    batchId: "3f1c2b8e-1d2a-4f5b-9c0d-112233445566",
    user,
    source: "web",
    pixels: [{ x: 0, y: 99999, color: 0xff0000 }],
  },
  "pixel.processed": {
    batchId: "b-1",
    userId: user.id,
    pixels: [{ x: 1, y: 1, color: 0x00ff00 }],
    rejected: [{ x: 2, y: 2, reason: "rate_limited" }],
  },
  "snapshot.requested": { requestId: "r-1", requestedBy: user.id, reason: "command", interaction },
};
