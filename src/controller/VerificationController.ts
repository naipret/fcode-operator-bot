import type { GuildMember } from 'discord.js';
import type { AppConfig } from '../config/ConfigSchema.js';
import type { Student, VerificationOutcome } from '../model/Student.js';
import type { StudentRepository } from '../repository/StudentRepository.js';
import type { GuildResourceResolver } from '../util/GuildResourceResolver.js';
import { InputValidator } from '../util/InputValidator.js';
import { Logger } from '../util/Logger.js';
import { MemberMutationHelper } from '../util/MemberMutationHelper.js';

/**
 * Coordinates candidate verification, instant rejoin restoration, and role synchronization.
 */
export class VerificationController {
  private appConfig: AppConfig;
  private readonly studentRepository: StudentRepository;
  private readonly resourceResolver: GuildResourceResolver;
  private readonly lockedDiscordIds: Set<string>;

  /**
   * Creates a VerificationController with its required repository, lock set, and configuration dependencies.
   *
   * @param appConfig the validated application configuration
   * @param studentRepository the SQLite student repository
   * @param resourceResolver the guild resource resolver
   * @param lockedDiscordIds shared Set tracking members currently mutated by the bot
   */
  public constructor(
    appConfig: AppConfig,
    studentRepository: StudentRepository,
    resourceResolver: GuildResourceResolver,
    lockedDiscordIds: Set<string>,
  ) {
    this.appConfig = appConfig;
    this.studentRepository = studentRepository;
    this.resourceResolver = resourceResolver;
    this.lockedDiscordIds = lockedDiscordIds;
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

    const lockResult = await MemberMutationHelper.runWithMemberLock(
      this.lockedDiscordIds,
      member.id,
      () => this.restoreExistingStudent(member, existingStudent),
    );
    return lockResult.acquired ? lockResult.value : this.buildLockedOutcome(member.id);
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
    const lockResult = await MemberMutationHelper.runWithMemberLock(
      this.lockedDiscordIds,
      member.id,
      () => this.executeNewRegistration(member, rawFullName, rawStudentId),
    );
    return lockResult.acquired ? lockResult.value : this.buildLockedOutcome(member.id);
  }

  /**
   * Synchronizes manual Discord round role additions or removals into local SQLite storage.
   *
   * @param member the updated Discord guild member from guildMemberUpdate
   */
  public syncMemberRolesToDatabase(member: GuildMember): void {
    if (this.lockedDiscordIds.has(member.id)) {
      return;
    }

    const existingStudent = this.studentRepository.findByDiscordId(member.id);
    if (!existingStudent || !existingStudent.isVerified) {
      return;
    }

    const { roundRoleIds } = this.appConfig.permissions;
    const isRound1 = member.roles.cache.has(roundRoleIds.round1);
    const isRound2 = member.roles.cache.has(roundRoleIds.round2);
    const isRound3 = member.roles.cache.has(roundRoleIds.round3);

    const hasChanged =
      existingStudent.isRound1 !== isRound1 ||
      existingStudent.isRound2 !== isRound2 ||
      existingStudent.isRound3 !== isRound3;

    if (!hasChanged) {
      return;
    }

    this.studentRepository.syncRoleStateByDiscordId(member.id, {
      isRound1,
      isRound2,
      isRound3,
    });
    Logger.info('VerificationController', 'Synchronized member round role update to database', {
      discordId: member.id,
      studentId: existingStudent.studentId,
      isRound1,
      isRound2,
      isRound3,
    });
  }

  /**
   * Executes new candidate validation, conflict detection, Discord mutation, and persistence.
   *
   * @param member the Discord guild member requesting verification
   * @param rawFullName the raw full name entered by the user
   * @param rawStudentId the raw student identifier entered by the user
   * @returns a structured VerificationOutcome
   */
  private async executeNewRegistration(
    member: GuildMember,
    rawFullName: string,
    rawStudentId: string,
  ): Promise<VerificationOutcome> {
    const existingByDiscord = this.studentRepository.findByDiscordId(member.id);
    if (existingByDiscord?.isVerified) {
      return await this.restoreExistingStudent(member, existingByDiscord);
    }

    if (!this.studentRepository.isVerificationEnabled()) {
      Logger.warn('VerificationController', 'Verification rejected because gate is closed', {
        discordId: member.id,
      });
      return {
        status: 'GATE_CLOSED',
        title: 'Verification Closed',
        description: this.appConfig.messages.verificationClosedMessage,
      };
    }

    const nicknameResult = InputValidator.buildValidatedNickname(
      rawFullName,
      rawStudentId,
      this.appConfig.bot,
    );
    if (!nicknameResult.valid) {
      return this.buildInvalidInputOutcome(member.id, rawStudentId, nicknameResult);
    }

    const existingByStudentId = this.studentRepository.findByStudentId(nicknameResult.studentId);
    if (existingByStudentId && existingByStudentId.discordId !== member.id) {
      Logger.warn('VerificationController', 'Verification rejected due to duplicate student ID', {
        discordId: member.id,
        studentId: nicknameResult.studentId,
        existingDiscordId: existingByStudentId.discordId,
      });
      return {
        status: 'CONFLICT',
        title: this.appConfig.messages.verificationErrorTitle,
        description: `Student ID \`${nicknameResult.studentId}\` is already verified under another Discord account.`,
      };
    }

    const studentRecord = this.buildNewStudentRecord(
      member.id,
      nicknameResult.studentId,
      nicknameResult.formattedFullName,
    );
    return await this.commitNewStudentRegistration(member, studentRecord, nicknameResult.nickname);
  }

  /**
   * Maps an invalid nickname or student ID validation result into a structured VerificationOutcome.
   *
   * @param discordId the interacting user's Discord snowflake ID
   * @param rawStudentId the raw student ID entered by the user
   * @param nicknameResult the failed nickname validation result
   * @returns an INVALID_INPUT or NICKNAME_TOO_LONG VerificationOutcome
   */
  private buildInvalidInputOutcome(
    discordId: string,
    rawStudentId: string,
    nicknameResult: Extract<
      ReturnType<typeof InputValidator.buildValidatedNickname>,
      { valid: false }
    >,
  ): VerificationOutcome {
    if (nicknameResult.reason === 'NICKNAME_TOO_LONG') {
      Logger.warn(
        'VerificationController',
        'Verification rejected because formatted nickname exceeded limit',
        { discordId, studentId: rawStudentId },
      );
      return {
        status: 'NICKNAME_TOO_LONG',
        title: this.appConfig.messages.verificationErrorTitle,
        description: nicknameResult.error,
      };
    }

    Logger.warn('VerificationController', 'Verification rejected due to invalid input', {
      discordId,
      reason: nicknameResult.reason,
    });
    return {
      status: 'INVALID_INPUT',
      title: this.appConfig.messages.verificationErrorTitle,
      description: nicknameResult.error,
    };
  }

  /**
   * Constructs a new Student entity initialized with the configured default round flags.
   *
   * @param discordId the Discord user snowflake ID
   * @param studentId the validated uppercase student ID
   * @param fullName the normalized Title Case full name
   * @returns a Student record ready for persistence
   */
  private buildNewStudentRecord(discordId: string, studentId: string, fullName: string): Student {
    const defaultRound = this.appConfig.verification.defaultRound;
    return {
      studentId,
      fullName,
      discordId,
      isVerified: true,
      isRound1:
        defaultRound === 'round-1' || defaultRound === 'round-2' || defaultRound === 'round-3',
      isRound2: defaultRound === 'round-2' || defaultRound === 'round-3',
      isRound3: defaultRound === 'round-3',
    };
  }

  /**
   * Applies Discord nickname and roles for a new candidate and persists the record to SQLite.
   *
   * @param member the Discord guild member
   * @param studentRecord the new Student record
   * @param nickname the formatted Discord nickname
   * @returns a VERIFIED VerificationOutcome
   */
  private async commitNewStudentRegistration(
    member: GuildMember,
    studentRecord: Student,
    nickname: string,
  ): Promise<VerificationOutcome> {
    const targetRoleIds = MemberMutationHelper.buildDesiredRoleIds(
      member,
      studentRecord,
      this.appConfig.permissions,
    );
    const hierarchyWarning = await MemberMutationHelper.applyMemberNicknameAndRoles(
      member,
      nickname,
      targetRoleIds,
      'VerificationController',
    );

    this.studentRepository.upsertStudent(studentRecord);
    Logger.info('VerificationController', 'Registered new student', {
      discordId: member.id,
      studentId: studentRecord.studentId,
      fullName: studentRecord.fullName,
      nickname,
      defaultRound: this.appConfig.verification.defaultRound,
    });

    const verifiedRoleId = this.resourceResolver.getVerifiedRoleId();
    const activeRounds = this.formatActiveRoundsSummary(studentRecord);
    const roundLine = activeRounds !== 'None' ? `\nUnlocked Rounds: ${activeRounds}` : '';
    return {
      status: 'VERIFIED',
      title: this.appConfig.messages.verificationSuccessTitle,
      description: `Your identity has been verified.\n\nFull Name: \`${studentRecord.fullName}\`\nNickname: \`${nickname}\`\nStudent ID: \`${studentRecord.studentId}\`\nAssigned Role: <@&${verifiedRoleId}>${roundLine}`,
      student: studentRecord,
      appliedNickname: nickname,
      nicknameHierarchyWarning: hierarchyWarning ?? undefined,
    };
  }

  /**
   * Restores nickname and active roles for a returning student.
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
    const desiredRoleIds = MemberMutationHelper.buildDesiredRoleIds(
      member,
      student,
      this.appConfig.permissions,
    );

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
        title: this.appConfig.messages.verificationAlreadyVerifiedTitle,
        description: `Your account is already verified and active.\n\nFull Name: \`${student.fullName}\`\nNickname: \`${expectedNickname}\`\nStudent ID: \`${student.studentId}\``,
        student,
        appliedNickname: expectedNickname,
      };
    }

    const hierarchyWarning = await MemberMutationHelper.applyMemberNicknameAndRoles(
      member,
      expectedNickname,
      desiredRoleIds,
      'VerificationController',
    );

    Logger.info('VerificationController', 'Restored returning student roles and nickname', {
      discordId: member.id,
      studentId: student.studentId,
      restoredRolesCount: missingRoles.length,
    });

    const restoredRounds = this.formatActiveRoundsSummary(student);
    return {
      status: 'RESTORED',
      title: this.appConfig.messages.verificationRestoredTitle,
      description: `Welcome back. Your verified identity and assigned roles have been restored.\n\nFull Name: \`${student.fullName}\`\nNickname: \`${expectedNickname}\`\nStudent ID: \`${student.studentId}\`\nActive Rounds: ${restoredRounds}`,
      student,
      appliedNickname: expectedNickname,
      nicknameHierarchyWarning: hierarchyWarning ?? undefined,
    };
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
   * Formats active round flags into a readable summary string with role mentions.
   *
   * @param student the student domain record
   * @returns a formatted string listing active rounds or "None"
   */
  private formatActiveRoundsSummary(student: Student): string {
    const active: string[] = [];
    if (student.isRound1) {
      active.push(`<@&${this.resourceResolver.getRoundRoleId('round-1')}>`);
    }
    if (student.isRound2) {
      active.push(`<@&${this.resourceResolver.getRoundRoleId('round-2')}>`);
    }
    if (student.isRound3) {
      active.push(`<@&${this.resourceResolver.getRoundRoleId('round-3')}>`);
    }
    return active.length > 0 ? active.join(', ') : 'None';
  }
}
