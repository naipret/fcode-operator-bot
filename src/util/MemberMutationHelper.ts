import { DiscordAPIError, type GuildMember } from "discord.js";
import type { AppConfig } from "../config/ConfigSchema.js";
import type { Student } from "../model/Student.js";
import { Logger } from "./Logger.js";

const DISCORD_MISSING_PERMISSIONS_CODE = 50013;

/**
 * Target staff role transition mode when updating Discord roles.
 */
export type StaffTransitionTarget = "MOD" | "SUP" | "NONE" | "KEEP";

/**
 * Result returned by runWithMemberLock indicating whether the member lock was acquired.
 */
export type MemberLockResult<T> =
  { acquired: false } | { acquired: true; value: T };

/**
 * Executes an asynchronous member operation while holding a per-user mutex lock.
 *
 * @param lockedDiscordIds shared Set tracking in-flight Discord user IDs
 * @param discordId the target Discord user snowflake ID
 * @param operation the async work to execute under lock
 * @returns an object indicating lock acquisition and operation result
 */
async function runWithMemberLock<T>(
  lockedDiscordIds: Set<string>,
  discordId: string,
  operation: () => Promise<T>,
): Promise<MemberLockResult<T>> {
  if (lockedDiscordIds.has(discordId)) {
    return { acquired: false };
  }

  lockedDiscordIds.add(discordId);
  try {
    const value = await operation();
    return { acquired: true, value };
  } finally {
    lockedDiscordIds.delete(discordId);
  }
}

/**
 * Collects all managed verified and round role Snowflake IDs from permissions config.
 *
 * @param permissions the configured permission role IDs
 * @returns a Set of managed recruitment role Snowflake IDs
 */
function getManagedRoleIdsSet(
  permissions: AppConfig["permissions"],
): Set<string> {
  return new Set<string>([
    permissions.verifiedRoleId,
    permissions.roundRoleIds.round1,
    permissions.roundRoleIds.round2,
    permissions.roundRoleIds.round3,
  ]);
}

/**
 * Returns role IDs on a member excluding bot-managed verified and round roles.
 *
 * @param member the target Discord guild member
 * @param permissions the configured permission role IDs
 * @returns array of preserved Discord role Snowflake IDs
 */
function getPreservedRoleIds(
  member: GuildMember,
  permissions: AppConfig["permissions"],
): string[] {
  const managedIds = getManagedRoleIdsSet(permissions);
  return member.roles.cache
    .filter((role) => role.id !== member.guild.id && !managedIds.has(role.id))
    .map((role) => role.id);
}

/**
 * Computes desired Discord role IDs while preserving non-recruitment member roles.
 *
 * @param member the target Discord guild member
 * @param student the student domain record governing managed roles
 * @param permissions the configured permission role IDs
 * @returns deduplicated Discord role Snowflake IDs to assign on the member
 */
function buildDesiredRoleIds(
  member: GuildMember,
  student: Student,
  permissions: AppConfig["permissions"],
): string[] {
  const targetIds = new Set<string>(getPreservedRoleIds(member, permissions));
  const { verifiedRoleId, roundRoleIds } = permissions;

  if (student.isVerified && member.guild.roles.cache.has(verifiedRoleId)) {
    targetIds.add(verifiedRoleId);
  }
  if (student.isRound1 && member.guild.roles.cache.has(roundRoleIds.round1)) {
    targetIds.add(roundRoleIds.round1);
  }
  if (student.isRound2 && member.guild.roles.cache.has(roundRoleIds.round2)) {
    targetIds.add(roundRoleIds.round2);
  }
  if (student.isRound3 && member.guild.roles.cache.has(roundRoleIds.round3)) {
    targetIds.add(roundRoleIds.round3);
  }

  return Array.from(targetIds);
}

/**
 * Computes Discord role IDs for staff promotion, switching, or downgrade reset.
 *
 * @param member the target Discord guild member
 * @param permissions the configured permission role IDs
 * @param targetStaffRole desired staff role state or KEEP for observer updates
 * @returns deduplicated Discord role Snowflake IDs preserving unrelated roles
 */
function getRoleIdsForStaffTransition(
  member: GuildMember,
  permissions: AppConfig["permissions"],
  targetStaffRole: StaffTransitionTarget,
): string[] {
  const basePreserved = getPreservedRoleIds(member, permissions);
  if (targetStaffRole === "KEEP") {
    return basePreserved;
  }

  const staffRoleIds = new Set<string>([
    permissions.moderatorRoleId,
    permissions.supporterRoleId,
  ]);
  const targetIds = new Set<string>(
    basePreserved.filter((roleId) => !staffRoleIds.has(roleId)),
  );

  if (
    targetStaffRole === "MOD" &&
    member.guild.roles.cache.has(permissions.moderatorRoleId)
  ) {
    targetIds.add(permissions.moderatorRoleId);
  } else if (
    targetStaffRole === "SUP" &&
    member.guild.roles.cache.has(permissions.supporterRoleId)
  ) {
    targetIds.add(permissions.supporterRoleId);
  }

  return Array.from(targetIds);
}

/**
 * Mutates member roles as a fallback when Discord blocks nickname edits for higher-ranked members.
 *
 * @param member the target Discord guild member
 * @param nickname the desired nickname or null when clearing
 * @param roleIds the complete target role ID array
 * @param contextName caller label used in structured logs
 * @returns a user-facing hierarchy warning message
 */
async function applyRolesOnlyFallback(
  member: GuildMember,
  nickname: string | null,
  roleIds: string[],
  contextName: string,
): Promise<string> {
  try {
    await member.edit({ roles: roleIds });
    return nickname === null
      ? "Discord prevented clearing the nickname due to role hierarchy."
      : `Discord prevented updating your nickname due to role hierarchy. Please set your nickname manually to \`${nickname}\`.`;
  } catch (fallbackError) {
    Logger.warn(
      contextName,
      `Fallback role edit failed with missing permissions: ${String(fallbackError)}`,
    );
    return "Discord prevents updating your profile due to role hierarchy. Please verify that the bot role is positioned above your roles.";
  }
}

/**
 * Mutates member nickname and roles in a single API call with graceful hierarchy fallback.
 *
 * @param member the target Discord guild member
 * @param nickname the desired server nickname or null to clear
 * @param roleIds the complete target role ID array
 * @param contextName caller label used in structured logs
 * @returns a warning string if Discord blocked nickname or role updates due to hierarchy, otherwise null
 */
async function applyMemberNicknameAndRoles(
  member: GuildMember,
  nickname: string | null,
  roleIds: string[],
  contextName: string,
): Promise<string | null> {
  if (member.id === member.guild.ownerId) {
    try {
      await member.edit({ roles: roleIds });
      return "Discord prevents changing the Server Owner nickname. Roles were updated; please update the nickname manually.";
    } catch (ownerError) {
      Logger.warn(
        contextName,
        `Role update skipped for guild owner: ${String(ownerError)}`,
      );
      return "Discord prevents bots from modifying the Server Owner profile. Please assign roles or nickname manually.";
    }
  }

  try {
    await member.edit({ nick: nickname, roles: roleIds });
    return null;
  } catch (error) {
    if (
      error instanceof DiscordAPIError &&
      error.code === DISCORD_MISSING_PERMISSIONS_CODE
    ) {
      return await applyRolesOnlyFallback(
        member,
        nickname,
        roleIds,
        contextName,
      );
    }
    throw error;
  }
}

/**
 * Centralizes shared per-member concurrency locks, role preservation, and Discord profile mutations.
 */
export const MemberMutationHelper = {
  runWithMemberLock,
  getPreservedRoleIds,
  buildDesiredRoleIds,
  getRoleIdsForStaffTransition,
  applyMemberNicknameAndRoles,
} as const;
