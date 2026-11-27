// Admin authorization, enforced in the worker (C07 §1.2).
//
// `default_member_permissions` in commands.json only hides /admin in the
// Discord UI, and a guild admin can change it. The worker
// therefore never trusts what Discord lets through, nor the member's
// permission bitfield: only the configured role ids and user ids count.

// Subject 3.2: only the /admin commands are admin-only; /draw, /get and
// /snapshot are open to every member.
export const ADMIN_COMMANDS = new Set(["admin"]);

/** True when the author of a `discord.command` event is an admin of the canvas. */
export function isAdmin(event, { adminRoleIds, adminUserIds }) {
  if (adminUserIds.has(event.user.id)) return true;
  return event.memberRoles.some((role) => adminRoleIds.has(role));
}

export function requiresAdmin(command) {
  return ADMIN_COMMANDS.has(command);
}
