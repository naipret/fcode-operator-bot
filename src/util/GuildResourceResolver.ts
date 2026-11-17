import type { Guild, GuildMember, PartialGuildMember, Role } from "discord.js";
import type { AppConfig } from "../config/ConfigSchema.js";
import type { RoundKey } from "../model/Student.js";

/**
 * Resolves configured Discord roles, log channels, and caller authorization by Snowflake ID.
 */
export class GuildResourceResolver {
  private appConfig: AppConfig;

  /**
   * Creates a GuildResourceResolver bound to the validated application configuration.
   *
   * @param appConfig the loaded application configuration
   */
  public constructor(appConfig: AppConfig) {
    this.appConfig = appConfig;
  }

  /**
   * Replaces the active configuration reference during a hot-reload.
   *
   * @param newConfig the newly validated application configuration
   */
  public updateConfig(newConfig: AppConfig): void {
    this.appConfig = newConfig;
  }

  /**
   * Returns the configured Discord Snowflake ID for the base verified role.
   *
   * @returns the configured verified role Snowflake ID
   */
  public getVerifiedRoleId(): string {
    return this.appConfig.permissions.verifiedRoleId;
  }

  /**
   * Returns the configured Discord Snowflake ID for the moderator role.
   *
   * @returns the configured moderator role Snowflake ID
   */
  public getModeratorRoleId(): string {
    return this.appConfig.permissions.moderatorRoleId;
  }

  /**
   * Returns the configured Discord Snowflake ID for the supporter role.
   *
   * @returns the configured supporter role Snowflake ID
   */
  public getSupporterRoleId(): string {
    return this.appConfig.permissions.supporterRoleId;
  }

  /**
   * Resolves the highest-precedence staff tier currently held by a guild member.
   *
   * @param member the guild member or partial member snapshot
   * @returns "MOD" if moderator, "SUP" if supporter only, or null otherwise
   */
  public resolveStaffTier(
    member: GuildMember | PartialGuildMember,
  ): "MOD" | "SUP" | null {
    if (member.roles.cache.has(this.appConfig.permissions.moderatorRoleId)) {
      return "MOD";
    }
    if (member.roles.cache.has(this.appConfig.permissions.supporterRoleId)) {
      return "SUP";
    }
    return null;
  }

  /**
   * Returns the configured nickname prefix corresponding to a staff tier.
   *
   * @param tier the resolved staff tier
   * @returns configured moderatorPrefix or supporterPrefix
   */
  public getPrefixForStaffTier(tier: "MOD" | "SUP"): string {
    return tier === "MOD"
      ? this.appConfig.bot.moderatorPrefix
      : this.appConfig.bot.supporterPrefix;
  }

  /**
   * Returns the configured Discord Snowflake ID for a given round key.
   *
   * @param roundKey the round identifier
   * @returns the configured Discord role Snowflake ID
   */
  public getRoundRoleId(roundKey: RoundKey): string {
    switch (roundKey) {
      case "round-1":
        return this.appConfig.permissions.roundRoleIds.round1;
      case "round-2":
        return this.appConfig.permissions.roundRoleIds.round2;
      case "round-3":
        return this.appConfig.permissions.roundRoleIds.round3;
    }
  }

  /**
   * Resolves a configured round role from the guild cache by its Snowflake ID.
   *
   * @param guild the target Discord guild
   * @param roundKey the round identifier
   * @returns the matching Discord Role or null when absent
   */
  public getRoundRole(guild: Guild, roundKey: RoundKey): Role | null {
    return guild.roles.cache.get(this.getRoundRoleId(roundKey)) ?? null;
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
   * Verifies that all configured Discord role IDs and optional log channel ID exist in the target guild.
   *
   * @param guild the target Discord guild after fetching roles and channels
   * @returns an array of descriptive missing resource messages (empty when all IDs resolve)
   */
  public validateConfiguredResources(guild: Guild): string[] {
    const missing: string[] = [];

    if (!guild.roles.cache.has(this.appConfig.permissions.ownerRoleId)) {
      missing.push(
        `permissions.ownerRoleId (${this.appConfig.permissions.ownerRoleId})`,
      );
    }
    if (!guild.roles.cache.has(this.appConfig.permissions.moderatorRoleId)) {
      missing.push(
        `permissions.moderatorRoleId (${this.appConfig.permissions.moderatorRoleId})`,
      );
    }
    if (!guild.roles.cache.has(this.appConfig.permissions.supporterRoleId)) {
      missing.push(
        `permissions.supporterRoleId (${this.appConfig.permissions.supporterRoleId})`,
      );
    }
    if (!guild.roles.cache.has(this.appConfig.permissions.verifiedRoleId)) {
      missing.push(
        `permissions.verifiedRoleId (${this.appConfig.permissions.verifiedRoleId})`,
      );
    }
    if (
      !guild.roles.cache.has(this.appConfig.permissions.roundRoleIds.round1)
    ) {
      missing.push(
        `permissions.roundRoleIds.round1 (${this.appConfig.permissions.roundRoleIds.round1})`,
      );
    }
    if (
      !guild.roles.cache.has(this.appConfig.permissions.roundRoleIds.round2)
    ) {
      missing.push(
        `permissions.roundRoleIds.round2 (${this.appConfig.permissions.roundRoleIds.round2})`,
      );
    }
    if (
      !guild.roles.cache.has(this.appConfig.permissions.roundRoleIds.round3)
    ) {
      missing.push(
        `permissions.roundRoleIds.round3 (${this.appConfig.permissions.roundRoleIds.round3})`,
      );
    }
    if (
      this.appConfig.logging.discord.enabled &&
      !guild.channels.cache.has(this.appConfig.logging.discord.channelId)
    ) {
      missing.push(
        `logging.discord.channelId (${this.appConfig.logging.discord.channelId})`,
      );
    }

    return missing;
  }
}
