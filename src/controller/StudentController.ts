import { DiscordAPIError, type Guild, type GuildMember } from 'discord.js';
import type { AppConfig } from '../config/ConfigSchema.js';
import type { Student } from '../model/Student.js';
import type { StudentRepository } from '../repository/StudentRepository.js';
import type { GuildResourceResolver } from '../util/GuildResourceResolver.js';
import { InputValidator } from '../util/InputValidator.js';
import { Logger } from '../util/Logger.js';

/**
 * Result returned by manual student lookup, register, and reset commands.
 */
export interface StudentActionOutcome {
  success: boolean;
  title: string;
  description: string;
  student?: Student;
}

/**
 * Result returned by SQLite-to-Discord student synchronization runs.
 */
export interface StudentSyncOutcome {
  success: boolean;
  title: string;
  description: string;
  updatedCount: number;
  skippedCount: number;
  failedMembers: string[];
}

/**
 * Handles moderator and owner commands for inspecting, registering, resetting, and syncing students.
 */
export class StudentController {
  private static readonly DISCORD_MISSING_PERMISSIONS_CODE = 50013;
  private appConfig: AppConfig;
  private readonly studentRepository: StudentRepository;
  private readonly resourceResolver: GuildResourceResolver;

  /**
   * Creates a StudentController bound to configuration, repository, and guild resolver.
   *
   * @param appConfig the validated application configuration
   * @param studentRepository the SQLite student repository
   * @param resourceResolver the guild resource resolver
   */
  public constructor(
    appConfig: AppConfig,
    studentRepository: StudentRepository,
    resourceResolver: GuildResourceResolver,
  ) {
    this.appConfig = appConfig;
    this.studentRepository = studentRepository;
    this.resourceResolver = resourceResolver;
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
   * Resolves a single student record from a unified target string (@mention, Discord ID, or Student ID).
   *
   * @param target raw target input from slash command options
   * @returns the matched Student entity or null when absent
   */
  private resolveStudentByTarget(target: string): Student | null {
    const tokens = InputValidator.parseTargetTokens(target);
    for (const discordId of tokens.discordIds) {
      const found = this.studentRepository.findByDiscordId(discordId);
      if (found) {
        return found;
      }
    }
    for (const studentId of tokens.studentIds) {
      const found = this.studentRepository.findByStudentId(studentId);
      if (found) {
        return found;
      }
    }

    const trimmed = target.trim();
    if (/^\d{17,20}$/.test(trimmed)) {
      return this.studentRepository.findByDiscordId(trimmed);
    }
    if (trimmed.length > 0) {
      return this.studentRepository.findByStudentId(trimmed.toUpperCase());
    }
    return null;
  }

  /**
   * Looks up a student record by @mention, Discord ID, or Student ID.
   *
   * @param target unified target identifier string
   * @returns a StudentActionOutcome containing the student details if found
   */
  public lookupStudent(target: string): StudentActionOutcome {
    const student = this.resolveStudentByTarget(target);
    if (!student) {
      return {
        success: false,
        title: 'Student Not Found',
        description: 'No student record matched the provided user or Student ID.',
      };
    }

    const nickname = InputValidator.formatNickname(
      student.fullName,
      student.studentId,
      this.appConfig.bot,
    );
    const rounds = [
      student.isRound1 ? `<@&${this.resourceResolver.getRoundRoleId('round-1')}>` : null,
      student.isRound2 ? `<@&${this.resourceResolver.getRoundRoleId('round-2')}>` : null,
      student.isRound3 ? `<@&${this.resourceResolver.getRoundRoleId('round-3')}>` : null,
    ]
      .filter((entry): entry is string => entry !== null)
      .join(', ');

    return {
      success: true,
      title: `Student Record: ${student.studentId}`,
      description: [
        `Discord User: <@${student.discordId}> (\`${student.discordId}\`)`,
        `Full Name: \`${student.fullName}\``,
        `Computed Nickname: \`${nickname}\``,
        `Verified: \`${student.isVerified ? 'Yes' : 'No'}\``,
        `Active Rounds: ${rounds.length > 0 ? rounds : 'None'}`,
      ].join('\n'),
      student,
    };
  }

  /**
   * Manually registers or updates a student record and Discord member profile for support resolution.
   *
   * @param member the target Discord guild member
   * @param rawFullName the full name or approved shortened name entered by the moderator
   * @param rawStudentId the student identifier entered by the moderator
   * @returns a StudentActionOutcome describing the applied state
   */
  public async registerStudentManually(
    member: GuildMember,
    rawFullName: string,
    rawStudentId: string,
  ): Promise<StudentActionOutcome> {
    const validation = InputValidator.buildValidatedNickname(
      rawFullName,
      rawStudentId,
      this.appConfig.bot,
    );
    if (!validation.valid) {
      return {
        success: false,
        title: 'Invalid Student Information',
        description: validation.error,
      };
    }

    const existingById = this.studentRepository.findByStudentId(validation.studentId);
    if (existingById && existingById.discordId !== member.id) {
      return {
        success: false,
        title: 'Duplicate Student ID',
        description: `Student ID \`${validation.studentId}\` is already assigned to <@${existingById.discordId}>. Reset that record first before reassigning it.`,
      };
    }

    const existingByDiscord = this.studentRepository.findByDiscordId(member.id);
    if (existingByDiscord && existingByDiscord.studentId !== validation.studentId) {
      this.studentRepository.deleteByDiscordId(member.id);
    }

    const defaultRound = this.appConfig.verification.defaultRound;
    const student: Student = {
      studentId: validation.studentId,
      fullName: validation.formattedFullName,
      discordId: member.id,
      isVerified: true,
      isRound1: existingByDiscord
        ? existingByDiscord.isRound1
        : defaultRound === 'round-1' || defaultRound === 'round-2' || defaultRound === 'round-3',
      isRound2: existingByDiscord
        ? existingByDiscord.isRound2
        : defaultRound === 'round-2' || defaultRound === 'round-3',
      isRound3: existingByDiscord ? existingByDiscord.isRound3 : defaultRound === 'round-3',
    };

    const roleIds = this.buildTargetRoleIds(member, student);
    let warningNote = '';

    try {
      await member.edit({ nick: validation.nickname, roles: roleIds });
    } catch (error) {
      if (
        error instanceof DiscordAPIError &&
        error.code === StudentController.DISCORD_MISSING_PERMISSIONS_CODE
      ) {
        await member.edit({ roles: roleIds });
        warningNote = `\n\nNote: Discord blocked nickname mutation due to role hierarchy. Expected nickname: \`${validation.nickname}\`.`;
      } else {
        throw error;
      }
    }

    this.studentRepository.upsertStudent(student);

    return {
      success: true,
      title: 'Student Registered Manually',
      description: `Updated <@${member.id}> successfully.\n\nFull Name: \`${student.fullName}\`\nNickname: \`${validation.nickname}\`\nStudent ID: \`${student.studentId}\`${warningNote}`,
      student,
    };
  }

  /**
   * Deletes a student record from SQLite and removes recruitment roles and nickname from Discord.
   *
   * @param guild the target Discord guild
   * @param target unified target string (@mention, Discord ID, or Student ID)
   * @returns a StudentActionOutcome summarizing the reset
   */
  public async resetStudent(guild: Guild, target: string): Promise<StudentActionOutcome> {
    const existingStudent = this.resolveStudentByTarget(target);
    if (!existingStudent) {
      return {
        success: false,
        title: 'Student Not Found',
        description: 'No student record matched the provided user or Student ID.',
      };
    }

    const member = await guild.members.fetch(existingStudent.discordId).catch(() => null);

    let discordCleanupNote = '';
    if (member) {
      const preservedRoles = this.getPreservedRoleIds(member);

      try {
        await member.edit({ nick: null, roles: preservedRoles });
      } catch (error) {
        if (
          error instanceof DiscordAPIError &&
          error.code === StudentController.DISCORD_MISSING_PERMISSIONS_CODE
        ) {
          discordCleanupNote =
            '\n\nNote: Could not strip Discord nickname or roles due to role hierarchy.';
        } else {
          throw error;
        }
      }
    }

    this.studentRepository.deleteByStudentId(existingStudent.studentId);

    return {
      success: true,
      title: 'Student Reset Complete',
      description: `Removed database record \`${existingStudent.studentId}\` (<@${existingStudent.discordId}>). The user may now re-verify from scratch.${discordCleanupNote}`,
    };
  }

  /**
   * Synchronizes verified SQLite student records (nickname and roles) to Discord.
   *
   * @param guild the target Discord guild
   * @param target optional unified target string (@mention, Discord ID, or Student ID)
   * @returns a StudentSyncOutcome summarizing updated, skipped, and failed members
   */
  public async syncStudentsToDiscord(
    guild: Guild,
    target?: string | null,
  ): Promise<StudentSyncOutcome> {
    let targets: Student[];
    if (target && target.trim().length > 0) {
      const matched = this.resolveStudentByTarget(target);
      if (!matched || !matched.isVerified) {
        return {
          success: false,
          title: 'Student Not Found',
          description: 'No verified student record matched the provided user or Student ID.',
          updatedCount: 0,
          skippedCount: 0,
          failedMembers: [],
        };
      }
      targets = [matched];
    } else {
      targets = this.studentRepository.listAllVerifiedStudents();
    }

    let updatedCount = 0;
    let skippedCount = 0;
    const failedMembers: string[] = [];

    for (const student of targets) {
      const member =
        guild.members.cache.get(student.discordId) ??
        (await guild.members.fetch(student.discordId).catch(() => null));
      if (!member) {
        failedMembers.push(`${student.studentId} (not in server)`);
        continue;
      }

      const expectedNickname = InputValidator.formatNickname(
        student.fullName,
        student.studentId,
        this.appConfig.bot,
      );
      const desiredRoleIds = this.buildTargetRoleIds(member, student);
      const currentRoleIds = new Set(
        member.roles.cache.filter((role) => role.id !== guild.id).map((role) => role.id),
      );
      const rolesMatch =
        desiredRoleIds.length === currentRoleIds.size &&
        desiredRoleIds.every((roleId) => currentRoleIds.has(roleId));
      const nicknameMatches = member.nickname === expectedNickname || member.id === guild.ownerId;

      if (rolesMatch && nicknameMatches) {
        skippedCount += 1;
        continue;
      }

      try {
        await member.edit({
          ...(member.id === guild.ownerId ? {} : { nick: expectedNickname }),
          roles: desiredRoleIds,
        });
        updatedCount += 1;
      } catch (error) {
        if (
          error instanceof DiscordAPIError &&
          error.code === StudentController.DISCORD_MISSING_PERMISSIONS_CODE &&
          !rolesMatch
        ) {
          try {
            await member.edit({ roles: desiredRoleIds });
            updatedCount += 1;
            continue;
          } catch (fallbackError) {
            Logger.warn(
              'StudentController',
              `Fallback role sync failed for ${student.studentId}: ${String(fallbackError)}`,
            );
          }
        } else {
          Logger.warn(
            'StudentController',
            `Failed syncing ${student.studentId} to Discord: ${String(error)}`,
          );
        }
        failedMembers.push(student.studentId);
      }
    }

    const failedSummary =
      failedMembers.length > 0
        ? `\nFailed (${failedMembers.length}): \`${failedMembers.join(', ')}\``
        : '';

    return {
      success: true,
      title: 'Database Sync Complete',
      description: `Reconciled \`${targets.length}\` verified student(s) from SQLite to Discord.\n\nUpdated: \`${updatedCount}\`\nAlready In Sync: \`${skippedCount}\`${failedSummary}`,
      updatedCount,
      skippedCount,
      failedMembers,
    };
  }

  /**
   * Returns role IDs on a member excluding bot-managed verified and round roles.
   *
   * @param member the target guild member
   * @returns array of preserved Discord role Snowflake IDs
   */
  private getPreservedRoleIds(member: GuildMember): string[] {
    const { verifiedRoleId, roundRoleIds } = this.appConfig.permissions;
    const managedRoleIds = new Set<string>([
      verifiedRoleId,
      roundRoleIds.round1,
      roundRoleIds.round2,
      roundRoleIds.round3,
    ]);

    return member.roles.cache
      .filter((role) => role.id !== member.guild.id && !managedRoleIds.has(role.id))
      .map((role) => role.id);
  }

  /**
   * Computes desired Discord role IDs while preserving non-recruitment member roles.
   *
   * @param member the target guild member
   * @param student the student domain record
   * @returns deduplicated role snowflake IDs
   */
  private buildTargetRoleIds(member: GuildMember, student: Student): string[] {
    const roleIds = new Set<string>(this.getPreservedRoleIds(member));
    const { verifiedRoleId, roundRoleIds } = this.appConfig.permissions;

    if (student.isVerified && member.guild.roles.cache.has(verifiedRoleId)) {
      roleIds.add(verifiedRoleId);
    }
    if (student.isRound1 && member.guild.roles.cache.has(roundRoleIds.round1)) {
      roleIds.add(roundRoleIds.round1);
    }
    if (student.isRound2 && member.guild.roles.cache.has(roundRoleIds.round2)) {
      roleIds.add(roundRoleIds.round2);
    }
    if (student.isRound3 && member.guild.roles.cache.has(roundRoleIds.round3)) {
      roleIds.add(roundRoleIds.round3);
    }

    return Array.from(roleIds);
  }
}
