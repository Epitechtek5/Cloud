// Discord interaction payloads (https://discord.com/developers/docs/interactions/receiving-and-responding).

export const InteractionType = Object.freeze({ PING: 1, APPLICATION_COMMAND: 2 });
export const ResponseType = Object.freeze({ PONG: 1, DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5 });
export const MessageFlags = Object.freeze({ EPHEMERAL: 1 << 6 });

const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;

// Commands whose answer only the caller should see.
const EPHEMERAL_COMMANDS = new Set(["admin"]);

/**
 * Flattens the options of a slash command:
 * `/admin ratelimit user:@bob limit:5` -> { subcommand: "ratelimit", options: { user: "<id>", limit: 5 } }.
 * A subcommand group is joined to its subcommand ("group subcommand").
 */
export function flattenOptions(data) {
  let options = data?.options ?? [];
  const path = [];
  while (options.length === 1 && (options[0].type === SUB_COMMAND || options[0].type === SUB_COMMAND_GROUP)) {
    path.push(options[0].name);
    options = options[0].options ?? [];
  }
  return {
    subcommand: path.length > 0 ? path.join(" ") : null,
    options: Object.fromEntries(options.map((o) => [o.name, o.value])),
  };
}

/** The `discord.command` event of an APPLICATION_COMMAND interaction (see src/lib/events.js). */
export function toCommandEvent(interaction) {
  const { subcommand, options } = flattenOptions(interaction.data);
  const member = interaction.member;
  // In a guild the user is under `member`, in a DM directly under `user`.
  const user = member?.user ?? interaction.user ?? {};
  return {
    interaction: { id: interaction.id, applicationId: interaction.application_id, token: interaction.token },
    command: interaction.data?.name,
    subcommand,
    options,
    guildId: interaction.guild_id ?? null,
    channelId: interaction.channel_id ?? interaction.channel?.id ?? null,
    user: { id: user.id, name: user.global_name ?? user.username },
    memberRoles: member?.roles ?? [],
    memberPermissions: member?.permissions ?? null,
  };
}

/** Deferred "thinking..." response; ephemeral for admin commands. */
export function deferredResponse(command) {
  return EPHEMERAL_COMMANDS.has(command)
    ? { type: ResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: MessageFlags.EPHEMERAL } }
    : { type: ResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE };
}
