import { DiscordAPIError, type GuildMember } from 'discord.js';
import type { AppConfig } from '../config/ConfigSchema.js';
import type { Student, VerificationOutcome } from '../model/Student.js';
import type { StudentRepository } from '../repository/StudentRepository.js';
import type { GuildResourceResolver } from '../util/GuildResourceResolver.js';
import { InputValidator } from '../util/InputValidator.js';
import { Logger } from '../util/Logger.js';

/**
 * Coordinates candidate verification, instant rejoin restoration, and role synchronization.
 */
export class VerificationController {
  private static readonly DISCORD_MISSING_PERMISSIONS_CODE = 50013;
  private readonly appConfig: AppConfig;
  private readonly studentRepository: StudentRepository;
  private readonly resourceResolver: GuildResourceResolver;
  private readonly inFlightUsers: Set<string>;

  /**
   * Creates a VerificationController with its required repository and configuration dependencies.
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
    this.inFlightUsers = new Set<string>();
  }

  /**
   * Returns whether candidate verification registrations are currently enabled.
   *
   * @returns true if verification is open
   */
  public isVerificationGateEnabled(): boolean {
    return this.studentRepository.isVerificationEnabled();
  }

  /**
   * Checks whether the interacting user already has a verified record and restores roles if needed.
   *
   * @param member the Discord guild member initiating verification
   * @returns a VerificationOutcome when an existing verified record exists, or null for new candidates
   */
  public async checkAndRestoreIfVerified(member: GuildMember): Promise<VerificationOutcome | null> {
    const existingStudent = this.studentRepository.findByDiscordId(member.id);
    if (!existingStudent || !existingStudent.isVerified) {
      return null;
    }

    if (this.inFlightUsers.has(member.id)) {
      return this.buildLockedOutcome(member.id);
    }

    this.inFlightUsers.add(member.id);
    try {
      return await this.restoreExistingStudent(member, existingStudent);
    } finally {
      this.inFlightUsers.delete(member.id);
    }
  }

  /**
   * Validates user input and registers a new student in a single verification step.
   *
   * @param member the Discord guild member requesting verification
   * @param rawFullName the raw full name entered by the user
   * @param rawStudentId the raw student identifier entered by the user
   * @returns a structured VerificationOutcome describing success or failure
   */
  public async registerNewStudent(
    member: GuildMember,
    rawFullName: string,
    rawStudentId: string,
  ): Promise<VerificationOutcome> {
    if (this.inFlightUsers.has(member.id)) {
      return this.buildLockedOutcome(member.id);
    }

    this.inFlightUsers.add(member.id);
    try {
      const existingByDiscord = this.studentRepository.findByDiscordId(member.id);
      if (existingByDiscord?.isVerified) {
        return await this.restoreExistingStudent(member, existingByDiscord);
      }

      if (!this.studentRepository.isVerificationEnabled()) {
        Logger.warn('VerificationController', 'Verification rejected because gate is closed', {
          discordId: member.id,
        });
        const supportMention = this.resourceResolver.getSupportChannelMention();
        return {
          status: 'GATE_CLOSED',
          title: 'Verification Closed',
          description: `${this.appConfig.messages.verificationClosedMessage} Support channel: ${supportMention}.`,
        };
      }

      const nicknameResult = InputValidator.buildValidatedNickname(
        rawFullName,
        rawStudentId,
        this.appConfig.bot,
      );
      if (!nicknameResult.valid) {
        const supportMention = this.resourceResolver.getSupportChannelMention();
        if (nicknameResult.reason === 'NICKNAME_TOO_LONG') {
          Logger.warn(
            'VerificationController',
            'Verification rejected because formatted nickname exceeded limit',
            { discordId: member.id, studentId: rawStudentId },
          );
          return {
            status: 'NICKNAME_TOO_LONG',
            title: this.appConfig.messages.verificationErrorTitle,
            description: `${nicknameResult.error}\n\nPlease contact support in ${supportMention} for assistance.`,
          };
        }

        Logger.warn('VerificationController', 'Verification rejected due to invalid input', {
          discordId: member.id,
          reason: nicknameResult.reason,
        });
        return {
          status: 'INVALID_INPUT',
          title: this.appConfig.messages.verificationErrorTitle,
          description: nicknameResult.error,
        };
      }

      const existingByStudentId = this.studentRepository.findByStudentId(nicknameResult.studentId);
      if (existingByStudentId && existingByStudentId.discordId !== member.id) {
        Logger.warn('VerificationController', 'Verification rejected due to duplicate student ID', {
          discordId: member.id,
          studentId: nicknameResult.studentId,
          existingDiscordId: existingByStudentId.discordId,
        });
        const supportMention = this.resourceResolver.getSupportChannelMention();
        return {
          status: 'CONFLICT',
          title: this.appConfig.messages.verificationErrorTitle,
          description: `Student ID \`${nicknameResult.studentId}\` is already verified under another Discord account. Please contact support in ${supportMention}.`,
        };
      }

      const studentRecord: Student = {
        studentId: nicknameResult.studentId,
        fullName: nicknameResult.formattedFullName,
        discordId: member.id,
        isVerified: true,
        isChallenge1: true,
        isChallenge2: false,
        isChallenge3: false,
      };

      const targetRoleIds = this.computeDesiredRoleIds(member, studentRecord);
      const hierarchyWarning = await this.applyMemberNicknameAndRoles(
        member,
        nicknameResult.nickname,
        targetRoleIds,
      );

      this.studentRepository.upsertStudent(studentRecord);
      Logger.info('VerificationController', 'Registered new student', {
        discordId: member.id,
        studentId: studentRecord.studentId,
        fullName: studentRecord.fullName,
        nickname: nicknameResult.nickname,
      });

      const stage1RoleId = this.resourceResolver.getStageRoleId('challenge-1');
      return {
        status: 'VERIFIED',
        title: this.appConfig.messages.verificationSuccessTitle,
        description: `Your identity has been verified.\n\nFull Name: \`${studentRecord.fullName}\`\nNickname: \`${nicknameResult.nickname}\`\nStudent ID: \`${studentRecord.studentId}\`\nUnlocked Stage: <@&${stage1RoleId}>`,
        student: studentRecord,
        appliedNickname: nicknameResult.nickname,
        nicknameHierarchyWarning: hierarchyWarning ?? undefined,
      };
    } finally {
      this.inFlightUsers.delete(member.id);
    }
  }

  /**
   * Synchronizes manual Discord role additions or removals into local SQLite storage.
   *
   * @param member the updated Discord guild member from guildMemberUpdate
   */
  public syncMemberRolesToDatabase(member: GuildMember): void {
    const existingStudent = this.studentRepository.findByDiscordId(member.id);
    if (!existingStudent || !existingStudent.isVerified) {
      return;
    }

    const { stageRoleIds } = this.appConfig.permissions;
    const isChallenge1 = member.roles.cache.has(stageRoleIds.challenge1);
    const isChallenge2 = member.roles.cache.has(stageRoleIds.challenge2);
    const isChallenge3 = member.roles.cache.has(stageRoleIds.challenge3);

    const hasChanged =
      existingStudent.isChallenge1 !== isChallenge1 ||
      existingStudent.isChallenge2 !== isChallenge2 ||
      existingStudent.isChallenge3 !== isChallenge3;

    if (!hasChanged) {
      return;
    }

    this.studentRepository.syncRoleStateByDiscordId(member.id, {
      isChallenge1,
      isChallenge2,
      isChallenge3,
    });
    Logger.info('VerificationController', 'Synchronized member role update to database', {
      discordId: member.id,
      studentId: existingStudent.studentId,
      isChallenge1,
      isChallenge2,
      isChallenge3,
    });
  }

  /**
   * Restores nickname, active stage roles, and team role for a returning student.
   *
   * @param member the returning Discord guild member
   * @param student the persisted Student record matched by discord_id
   * @returns a RESTORED or ALREADY_ACTIVE VerificationOutcome
   */
  private async restoreExistingStudent(
    member: GuildMember,
    student: Student,
  ): Promise<VerificationOutcome> {
    const expectedNickname = InputValidator.formatNickname(
      student.fullName,
      student.studentId,
      this.appConfig.bot,
    );
    const desiredRoleIds = this.computeDesiredRoleIds(member, student);

    const currentRoleIds = new Set(member.roles.cache.keys());
    const missingRoles = desiredRoleIds.filter((roleId) => !currentRoleIds.has(roleId));
    const nicknameMatches =
      member.nickname === expectedNickname || member.id === member.guild.ownerId;

    if (missingRoles.length === 0 && nicknameMatches) {
      Logger.debug('VerificationController', 'Member already verified and active', {
        discordId: member.id,
        studentId: student.studentId,
      });
      return {
        status: 'ALREADY_ACTIVE',
        title: this.appConfig.messages.verificationRestoredTitle,
        description: `Your account is already verified and active.\n\nFull Name: \`${student.fullName}\`\nNickname: \`${expectedNickname}\`\nStudent ID: \`${student.studentId}\``,
        student,
        appliedNickname: expectedNickname,
      };
    }

    const hierarchyWarning = await this.applyMemberNicknameAndRoles(
      member,
      expectedNickname,
      desiredRoleIds,
    );

    Logger.info('VerificationController', 'Restored returning student roles and nickname', {
      discordId: member.id,
      studentId: student.studentId,
      restoredRolesCount: missingRoles.length,
    });

    const restoredStages = this.formatActiveStagesSummary(student);
    return {
      status: 'RESTORED',
      title: this.appConfig.messages.verificationRestoredTitle,
      description: `Welcome back. Your verified identity and assigned roles have been restored.\n\nFull Name: \`${student.fullName}\`\nNickname: \`${expectedNickname}\`\nStudent ID: \`${student.studentId}\`\nActive Stages: ${restoredStages}`,
      student,
      appliedNickname: expectedNickname,
      nicknameHierarchyWarning: hierarchyWarning ?? undefined,
    };
  }

  /**
   * Computes the target Discord role ID array while preserving non-managed member roles.
   *
   * @param member the target Discord guild member
   * @param student the student domain record governing managed roles
   * @returns deduplicated Discord role snowflake IDs to assign on the member
   */
  private computeDesiredRoleIds(member: GuildMember, student: Student): string[] {
    const managedIds = this.getManagedStageRoleIdsSet();
    const preservedRoleIds = member.roles.cache
      .filter((role) => role.id !== member.guild.id && !managedIds.has(role.id))
      .map((role) => role.id);

    const targetIds = new Set<string>(preservedRoleIds);
    const { stageRoleIds } = this.appConfig.permissions;

    if (student.isChallenge1 && member.guild.roles.cache.has(stageRoleIds.challenge1)) {
      targetIds.add(stageRoleIds.challenge1);
    }
    if (student.isChallenge2 && member.guild.roles.cache.has(stageRoleIds.challenge2)) {
      targetIds.add(stageRoleIds.challenge2);
    }
    if (student.isChallenge3 && member.guild.roles.cache.has(stageRoleIds.challenge3)) {
      targetIds.add(stageRoleIds.challenge3);
    }

    return Array.from(targetIds);
  }

  /**
   * Collects all configured stage role Snowflake IDs managed by verification workflows.
   *
   * @returns a Set of configured stage role IDs
   */
  private getManagedStageRoleIdsSet(): Set<string> {
    const { stageRoleIds } = this.appConfig.permissions;
    return new Set<string>([
      stageRoleIds.challenge1,
      stageRoleIds.challenge2,
      stageRoleIds.challenge3,
    ]);
  }

  /**
   * Mutates member nickname and roles in a single API call with graceful hierarchy fallback.
   *
   * @param member the target Discord guild member
   * @param nickname the desired server nickname
   * @param roleIds the complete target role ID array
   * @returns a warning string if Discord blocked nickname or role updates due to hierarchy, otherwise null
   */
  private async applyMemberNicknameAndRoles(
    member: GuildMember,
    nickname: string,
    roleIds: string[],
  ): Promise<string | null> {
    if (member.id === member.guild.ownerId) {
      try {
        await member.edit({ roles: roleIds });
        return 'Discord prevents changing the Server Owner nickname. Roles were assigned; please update your nickname manually.';
      } catch (error) {
        Logger.warn(
          'VerificationController',
          `Role update skipped for guild owner: ${String(error)}`,
        );
        return 'Discord prevents bots from modifying the Server Owner profile. Please assign roles or nickname manually.';
      }
    }

    try {
      await member.edit({ nick: nickname, roles: roleIds });
      return null;
    } catch (error) {
      if (
        error instanceof DiscordAPIError &&
        error.code === VerificationController.DISCORD_MISSING_PERMISSIONS_CODE
      ) {
        try {
          await member.edit({ roles: roleIds });
          return `Discord prevented updating your nickname due to role hierarchy. Please set your nickname manually to \`${nickname}\`.`;
        } catch (fallbackError) {
          Logger.warn(
            'VerificationController',
            `Fallback role edit failed with missing permissions: ${String(fallbackError)}`,
          );
          return 'Discord prevents updating your profile due to role hierarchy. Please verify that the bot role is positioned above your roles.';
        }
      }
      throw error;
    }
  }

  /**
   * Builds a standardized outcome when a user triggers concurrent duplicate verification requests.
   *
   * @param discordId the interacting user's Discord snowflake ID
   * @returns a LOCKED VerificationOutcome
   */
  private buildLockedOutcome(discordId: string): VerificationOutcome {
    Logger.warn('VerificationController', 'Concurrent verification request blocked by mutex', {
      discordId,
    });
    return {
      status: 'LOCKED',
      title: 'Verification In Progress',
      description: 'Your previous verification request is still being processed. Please wait.',
    };
  }

  /**
   * Formats active stage flags into a readable summary string with role mentions.
   *
   * @param student the student domain record
   * @returns a formatted string listing active challenge stages or "None"
   */
  private formatActiveStagesSummary(student: Student): string {
    const active: string[] = [];
    if (student.isChallenge1) {
      active.push(`<@&${this.resourceResolver.getStageRoleId('challenge-1')}>`);
    }
    if (student.isChallenge2) {
      active.push(`<@&${this.resourceResolver.getStageRoleId('challenge-2')}>`);
    }
    if (student.isChallenge3) {
      active.push(`<@&${this.resourceResolver.getStageRoleId('challenge-3')}>`);
    }
    return active.length > 0 ? active.join(', ') : 'None';
  }
}
