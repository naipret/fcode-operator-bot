import type { Guild, GuildMember, Role } from 'discord.js';
import type { AppConfig } from '../config/ConfigSchema.js';
import type { ChallengeStageKey } from '../model/Student.js';

/**
 * Resolves configured Discord roles, support channel mentions, and caller authorization by Snowflake ID.
 */
export class GuildResourceResolver {
  private readonly appConfig: AppConfig;

  /**
   * Creates a GuildResourceResolver bound to the validated application configuration.
   *
   * @param appConfig the loaded application configuration
   */
  public constructor(appConfig: AppConfig) {
    this.appConfig = appConfig;
  }

  /**
   * Returns the configured Discord Snowflake ID for a given challenge stage key.
   *
   * @param stageKey the challenge stage identifier
   * @returns the configured Discord role Snowflake ID
   */
  public getStageRoleId(stageKey: ChallengeStageKey): string {
    switch (stageKey) {
      case 'challenge-1':
        return this.appConfig.permissions.stageRoleIds.challenge1;
      case 'challenge-2':
        return this.appConfig.permissions.stageRoleIds.challenge2;
      case 'challenge-3':
        return this.appConfig.permissions.stageRoleIds.challenge3;
    }
  }

  /**
   * Resolves a configured challenge stage role from the guild cache by its Snowflake ID.
   *
   * @param guild the target Discord guild
   * @param stageKey the challenge stage identifier
   * @returns the matching Discord Role or null when absent
   */
  public getStageRole(guild: Guild, stageKey: ChallengeStageKey): Role | null {
    return guild.roles.cache.get(this.getStageRoleId(stageKey)) ?? null;
  }

  /**
   * Formats a clickable channel mention for the configured support channel ID.
   *
   * @returns a Discord channel mention string
   */
  public getSupportChannelMention(): string {
    return `<#${this.appConfig.verification.supportChannelId}>`;
  }

  /**
   * Determines whether a guild member is the Server Owner or holds the configured owner role ID.
   *
   * @param guild the target Discord guild
   * @param member the guild member executing the interaction
   * @returns true if the caller is the guild owner or holds the configured owner role
   */
  public isOwnerOrHasOwnerRole(guild: Guild, member: GuildMember): boolean {
    if (guild.ownerId === member.id) {
      return true;
    }
    return member.roles.cache.has(this.appConfig.permissions.ownerRoleId);
  }

  /**
   * Determines whether a guild member has moderator-tier authorization.
   *
   * @param guild the target Discord guild
   * @param member the guild member executing the interaction
   * @returns true if the caller is the Server Owner, owner role holder, or moderator role holder
   */
  public isModeratorOrOwner(guild: Guild, member: GuildMember): boolean {
    if (this.isOwnerOrHasOwnerRole(guild, member)) {
      return true;
    }
    return member.roles.cache.has(this.appConfig.permissions.moderatorRoleId);
  }

  /**
   * Verifies that all configured Discord role IDs and the support channel ID exist in the target guild.
   *
   * @param guild the target Discord guild after fetching roles and channels
   * @returns an array of descriptive missing resource messages (empty when all IDs resolve)
   */
  public validateConfiguredResources(guild: Guild): string[] {
    const missing: string[] = [];

    if (!guild.channels.cache.has(this.appConfig.verification.supportChannelId)) {
      missing.push(
        `verification.supportChannelId (${this.appConfig.verification.supportChannelId})`,
      );
    }
    if (!guild.roles.cache.has(this.appConfig.permissions.ownerRoleId)) {
      missing.push(`permissions.ownerRoleId (${this.appConfig.permissions.ownerRoleId})`);
    }
    if (!guild.roles.cache.has(this.appConfig.permissions.moderatorRoleId)) {
      missing.push(`permissions.moderatorRoleId (${this.appConfig.permissions.moderatorRoleId})`);
    }
    if (!guild.roles.cache.has(this.appConfig.permissions.stageRoleIds.challenge1)) {
      missing.push(
        `permissions.stageRoleIds.challenge1 (${this.appConfig.permissions.stageRoleIds.challenge1})`,
      );
    }
    if (!guild.roles.cache.has(this.appConfig.permissions.stageRoleIds.challenge2)) {
      missing.push(
        `permissions.stageRoleIds.challenge2 (${this.appConfig.permissions.stageRoleIds.challenge2})`,
      );
    }
    if (!guild.roles.cache.has(this.appConfig.permissions.stageRoleIds.challenge3)) {
      missing.push(
        `permissions.stageRoleIds.challenge3 (${this.appConfig.permissions.stageRoleIds.challenge3})`,
      );
    }

    return missing;
  }
}
