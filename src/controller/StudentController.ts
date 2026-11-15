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
 * Handles moderator and owner commands for inspecting, registering, and resetting student records.
 */
export class StudentController {
  private static readonly DISCORD_MISSING_PERMISSIONS_CODE = 50013;
  private readonly appConfig: AppConfig;
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
   * Looks up a student record by student identifier or Discord user identifier.
   *
   * @param rawStudentId optional student identifier
   * @param discordId optional Discord user snowflake identifier
   * @returns a StudentActionOutcome containing the student details if found
   */
  public lookupStudent(
    rawStudentId: string | null,
    discordId: string | null,
  ): StudentActionOutcome {
    const student = rawStudentId
      ? this.studentRepository.findByStudentId(rawStudentId.trim().toUpperCase())
      : discordId
        ? this.studentRepository.findByDiscordId(discordId)
        : null;

    if (!student) {
      return {
        success: false,
        title: 'Student Not Found',
        description: 'No student record matched the provided Student ID or Discord user.',
      };
    }

    const nickname = InputValidator.formatNickname(
      student.fullName,
      student.studentId,
      this.appConfig.bot,
    );
    const stages = [
      student.isChallenge1 ? `<@&${this.resourceResolver.getStageRoleId('challenge-1')}>` : null,
      student.isChallenge2 ? `<@&${this.resourceResolver.getStageRoleId('challenge-2')}>` : null,
      student.isChallenge3 ? `<@&${this.resourceResolver.getStageRoleId('challenge-3')}>` : null,
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
        `Active Stages: ${stages.length > 0 ? stages : 'None'}`,
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

    const student: Student = {
      studentId: validation.studentId,
      fullName: validation.formattedFullName,
      discordId: member.id,
      isVerified: true,
      isChallenge1: existingByDiscord ? existingByDiscord.isChallenge1 : true,
      isChallenge2: existingByDiscord ? existingByDiscord.isChallenge2 : false,
      isChallenge3: existingByDiscord ? existingByDiscord.isChallenge3 : false,
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
   * @param rawStudentId optional student identifier
   * @param targetMember optional Discord guild member
   * @returns a StudentActionOutcome summarizing the reset
   */
  public async resetStudent(
    guild: Guild,
    rawStudentId: string | null,
    targetMember: GuildMember | null,
  ): Promise<StudentActionOutcome> {
    const existingStudent = rawStudentId
      ? this.studentRepository.findByStudentId(rawStudentId.trim().toUpperCase())
      : targetMember
        ? this.studentRepository.findByDiscordId(targetMember.id)
        : null;

    if (!existingStudent) {
      return {
        success: false,
        title: 'Student Not Found',
        description: 'No student record matched the provided Student ID or Discord user.',
      };
    }

    const member =
      targetMember ?? (await guild.members.fetch(existingStudent.discordId).catch(() => null));

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
   * Synchronizes verified SQLite student records (nickname and stage roles) to Discord.
   *
   * @param guild the target Discord guild
   * @param rawStudentId optional single student ID to sync
   * @param discordId optional single Discord user ID to sync
   * @returns a StudentSyncOutcome summarizing updated, skipped, and failed members
   */
  public async syncStudentsToDiscord(
    guild: Guild,
    rawStudentId?: string | null,
    discordId?: string | null,
  ): Promise<StudentSyncOutcome> {
    let targets: Student[];
    if (rawStudentId || discordId) {
      const matched = rawStudentId
        ? this.studentRepository.findByStudentId(rawStudentId.trim().toUpperCase())
        : discordId
          ? this.studentRepository.findByDiscordId(discordId)
          : null;
      if (!matched || !matched.isVerified) {
        return {
          success: false,
          title: 'Student Not Found',
          description:
            'No verified student record matched the provided Student ID or Discord user.',
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
   * Returns role IDs on a member excluding bot-managed stage roles.
   *
   * @param member the target guild member
   * @returns array of preserved Discord role Snowflake IDs
   */
  private getPreservedRoleIds(member: GuildMember): string[] {
    const { stageRoleIds } = this.appConfig.permissions;
    const managedStageIds = new Set<string>([
      stageRoleIds.challenge1,
      stageRoleIds.challenge2,
      stageRoleIds.challenge3,
    ]);

    return member.roles.cache
      .filter((role) => role.id !== member.guild.id && !managedStageIds.has(role.id))
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
    const { stageRoleIds } = this.appConfig.permissions;

    if (student.isChallenge1 && member.guild.roles.cache.has(stageRoleIds.challenge1)) {
      roleIds.add(stageRoleIds.challenge1);
    }
    if (student.isChallenge2 && member.guild.roles.cache.has(stageRoleIds.challenge2)) {
      roleIds.add(stageRoleIds.challenge2);
    }
    if (student.isChallenge3 && member.guild.roles.cache.has(stageRoleIds.challenge3)) {
      roleIds.add(stageRoleIds.challenge3);
    }

    return Array.from(roleIds);
  }
}
