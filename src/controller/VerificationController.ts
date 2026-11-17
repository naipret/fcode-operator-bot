import type { GuildMember, PartialGuildMember } from "discord.js";
import type { AppConfig } from "../config/ConfigSchema.js";
import type { Student, VerificationOutcome } from "../model/Student.js";
import type { StudentRepository } from "../repository/StudentRepository.js";
import type { GuildResourceResolver } from "../util/GuildResourceResolver.js";
import { InputValidator } from "../util/InputValidator.js";
import { Logger } from "../util/Logger.js";
import { MemberMutationHelper } from "../util/MemberMutationHelper.js";

/**
 * Coordinates candidate verification, instant rejoin restoration, and staff role lifecycle sync.
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
   * Checks whether the interacting user already has a verified record or active staff status.
   *
   * @param member the Discord guild member initiating verification
   * @returns a VerificationOutcome when an existing verified or staff identity exists, or null
   */
  public async checkAndRestoreIfVerified(
    member: GuildMember,
  ): Promise<VerificationOutcome | null> {
    const staffOutcome = await this.checkActiveStaffVerification(member);
    if (staffOutcome !== null) {
      return staffOutcome;
    }

    const existingStudent = this.studentRepository.findByDiscordId(member.id);
    if (!existingStudent?.isVerified) {
      return null;
    }

    const lockResult = await MemberMutationHelper.runWithMemberLock(
      this.lockedDiscordIds,
      member.id,
      () => this.restoreExistingStudent(member, existingStudent),
    );
    return lockResult.acquired
      ? lockResult.value
      : this.buildLockedOutcome(member.id);
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
    return lockResult.acquired
      ? lockResult.value
      : this.buildLockedOutcome(member.id);
  }

  /**
   * Synchronizes manual Discord round role and staff role changes into SQLite and nicknames.
   *
   * @param oldMember previous Discord guild member snapshot before update
   * @param newMember updated Discord guild member snapshot after update
   */
  public syncMemberRolesToDatabase(
    oldMember: GuildMember | PartialGuildMember,
    newMember: GuildMember,
  ): void {
    if (this.lockedDiscordIds.has(newMember.id)) {
      return;
    }

    const newStaffTier = this.resourceResolver.resolveStaffTier(newMember);
    const oldStaffTier = this.resourceResolver.resolveStaffTier(oldMember);
    const hadStaffState =
      oldStaffTier !== null || this.hasStaffNicknamePrefix(newMember.nickname);

    if (newStaffTier !== null) {
      void this.handleStaffPromotionOrSwitch(newMember, newStaffTier);
      return;
    }

    if (hadStaffState) {
      void this.handleStaffDowngradeReset(newMember);
      return;
    }

    this.syncCandidateRoundFlags(newMember);
  }

  /**
   * Reconciles manual Discord round role edits for non-staff verified candidates.
   *
   * @param member the updated Discord guild member
   */
  private syncCandidateRoundFlags(member: GuildMember): void {
    const existingStudent = this.studentRepository.findByDiscordId(member.id);
    if (!existingStudent?.isVerified) {
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
    Logger.info(
      "VerificationController",
      "Synchronized member round role update to database",
      {
        discordId: member.id,
        studentId: existingStudent.studentId,
        isRound1,
        isRound2,
        isRound3,
      },
    );
  }

  /**
   * Prevents active staff with a standardized nickname from re-verifying as a candidate.
   *
   * @param member the interacting guild member
   * @returns an ALREADY_ACTIVE VerificationOutcome or null if not yet standardized staff
   */
  private async checkActiveStaffVerification(
    member: GuildMember,
  ): Promise<VerificationOutcome | null> {
    const staffTier = this.resourceResolver.resolveStaffTier(member);
    if (staffTier === null) {
      return null;
    }

    const expectedPrefix =
      this.resourceResolver.getPrefixForStaffTier(staffTier);
    const expectedNickname = InputValidator.rewriteStandardizedNicknamePrefix(
      member.nickname,
      this.appConfig.bot,
      expectedPrefix,
    );
    if (expectedNickname === null) {
      return null;
    }

    const lockResult = await MemberMutationHelper.runWithMemberLock(
      this.lockedDiscordIds,
      member.id,
      async () => {
        this.studentRepository.deleteByDiscordId(member.id);
        const targetRoles = MemberMutationHelper.getRoleIdsForStaffTransition(
          member,
          this.appConfig.permissions,
          "KEEP",
        );
        const hierarchyWarning = await this.syncStaffMemberIfNeeded(
          member,
          expectedNickname,
          targetRoles,
        );
        return {
          status: "ALREADY_ACTIVE" as const,
          title: this.appConfig.messages.verificationAlreadyVerifiedTitle,
          description: `Your staff account is already verified and active.\n\nNickname: \`${expectedNickname}\``,
          appliedNickname: expectedNickname,
          nicknameHierarchyWarning: hierarchyWarning ?? undefined,
        };
      },
    );

    return lockResult.acquired
      ? lockResult.value
      : this.buildLockedOutcome(member.id);
  }

  /**
   * Promotes a verified candidate or switches an existing staff member's prefix on role change.
   *
   * @param member the updated Discord guild member
   * @param staffTier the resolved highest-precedence staff tier
   */
  private async handleStaffPromotionOrSwitch(
    member: GuildMember,
    staffTier: "MOD" | "SUP",
  ): Promise<void> {
    await MemberMutationHelper.runWithMemberLock(
      this.lockedDiscordIds,
      member.id,
      async () => {
        const targetPrefix =
          this.resourceResolver.getPrefixForStaffTier(staffTier);
        const existingStudent = this.studentRepository.findByDiscordId(
          member.id,
        );

        const nextNickname = existingStudent
          ? InputValidator.formatNickname(
              existingStudent.fullName,
              existingStudent.studentId,
              this.appConfig.bot,
              targetPrefix,
            )
          : InputValidator.rewriteStandardizedNicknamePrefix(
              member.nickname,
              this.appConfig.bot,
              targetPrefix,
            );

        if (nextNickname === null) {
          return;
        }

        if (existingStudent) {
          this.studentRepository.deleteByDiscordId(member.id);
        }

        const targetRoleIds = MemberMutationHelper.getRoleIdsForStaffTransition(
          member,
          this.appConfig.permissions,
          "KEEP",
        );
        await this.syncStaffMemberIfNeeded(member, nextNickname, targetRoleIds);
        Logger.info(
          "VerificationController",
          "Applied staff promotion or prefix switch",
          {
            discordId: member.id,
            staffTier,
            nickname: nextNickname,
          },
        );
      },
    );
  }

  /**
   * Resets nickname, candidate roles, and SQLite record when all staff roles are removed.
   *
   * @param member the downgraded Discord guild member
   */
  private async handleStaffDowngradeReset(member: GuildMember): Promise<void> {
    await MemberMutationHelper.runWithMemberLock(
      this.lockedDiscordIds,
      member.id,
      async () => {
        this.studentRepository.deleteByDiscordId(member.id);
        const preservedRoleIds = MemberMutationHelper.getPreservedRoleIds(
          member,
          this.appConfig.permissions,
        );
        await MemberMutationHelper.applyMemberNicknameAndRoles(
          member,
          null,
          preservedRoleIds,
          "VerificationController",
        );
        Logger.info(
          "VerificationController",
          "Reset downgraded staff member profile for re-verification",
          { discordId: member.id },
        );
      },
    );
  }

  /**
   * Applies nickname and role cleanup for a staff member only when Discord state differs.
   *
   * @param member the target Discord guild member
   * @param expectedNickname target MOD or SUP nickname
   * @param targetRoleIds target preserved plus staff role IDs
   * @returns optional hierarchy warning message
   */
  private async syncStaffMemberIfNeeded(
    member: GuildMember,
    expectedNickname: string,
    targetRoleIds: string[],
  ): Promise<string | null> {
    const currentRoleIds = new Set(
      member.roles.cache
        .filter((role) => role.id !== member.guild.id)
        .map((role) => role.id),
    );
    const rolesMatch =
      targetRoleIds.length === currentRoleIds.size &&
      targetRoleIds.every((roleId) => currentRoleIds.has(roleId));
    const nicknameMatches =
      member.nickname === expectedNickname ||
      member.id === member.guild.ownerId;

    if (rolesMatch && nicknameMatches) {
      return null;
    }

    return await MemberMutationHelper.applyMemberNicknameAndRoles(
      member,
      expectedNickname,
      targetRoleIds,
      "VerificationController",
    );
  }

  /**
   * Checks whether a nickname currently carries the configured moderator or supporter prefix.
   *
   * @param nickname current guild nickname or null
   * @returns true if standardized and prefixed with moderatorPrefix or supporterPrefix
   */
  private hasStaffNicknamePrefix(nickname: string | null): boolean {
    if (
      !nickname ||
      !InputValidator.hasStandardizedNickname(nickname, this.appConfig.bot)
    ) {
      return false;
    }

    const { clubCohortPrefix, moderatorPrefix, supporterPrefix } =
      this.appConfig.bot;
    const candidateEquivalent =
      InputValidator.rewriteStandardizedNicknamePrefix(
        nickname,
        this.appConfig.bot,
        clubCohortPrefix,
      );
    const moderatorMatches =
      moderatorPrefix !== clubCohortPrefix &&
      nickname ===
        InputValidator.rewriteStandardizedNicknamePrefix(
          nickname,
          this.appConfig.bot,
          moderatorPrefix,
        );
    const supporterMatches =
      supporterPrefix !== clubCohortPrefix &&
      nickname ===
        InputValidator.rewriteStandardizedNicknamePrefix(
          nickname,
          this.appConfig.bot,
          supporterPrefix,
        );

    return (
      candidateEquivalent !== null && (moderatorMatches || supporterMatches)
    );
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
    const staffOutcome =
      await this.checkActiveStaffVerificationInsideLock(member);
    if (staffOutcome !== null) {
      return staffOutcome;
    }

    const existingByDiscord = this.studentRepository.findByDiscordId(member.id);
    if (existingByDiscord?.isVerified) {
      return await this.restoreExistingStudent(member, existingByDiscord);
    }

    if (!this.studentRepository.isVerificationEnabled()) {
      Logger.warn(
        "VerificationController",
        "Verification rejected because gate is closed",
        {
          discordId: member.id,
        },
      );
      return {
        status: "GATE_CLOSED",
        title: "Verification Closed",
        description: this.appConfig.messages.verificationClosedMessage,
      };
    }

    const nicknameResult = InputValidator.buildValidatedNickname(
      rawFullName,
      rawStudentId,
      this.appConfig.bot,
    );
    if (!nicknameResult.valid) {
      return this.buildInvalidInputOutcome(
        member.id,
        rawStudentId,
        nicknameResult,
      );
    }

    const existingByStudentId = this.studentRepository.findByStudentId(
      nicknameResult.studentId,
    );
    if (existingByStudentId && existingByStudentId.discordId !== member.id) {
      Logger.warn(
        "VerificationController",
        "Verification rejected due to duplicate student ID",
        {
          discordId: member.id,
          studentId: nicknameResult.studentId,
          existingDiscordId: existingByStudentId.discordId,
        },
      );
      return {
        status: "CONFLICT",
        title: this.appConfig.messages.verificationErrorTitle,
        description: `Student ID \`${nicknameResult.studentId}\` is already verified under another Discord account.`,
      };
    }

    const studentRecord = this.buildNewStudentRecord(
      member.id,
      nicknameResult.studentId,
      nicknameResult.formattedFullName,
    );
    return await this.commitNewStudentRegistration(
      member,
      studentRecord,
      nicknameResult.nickname,
    );
  }

  /**
   * Checks active staff status when already executing inside the per-member mutex lock.
   *
   * @param member the interacting guild member
   * @returns an ALREADY_ACTIVE VerificationOutcome or null
   */
  private async checkActiveStaffVerificationInsideLock(
    member: GuildMember,
  ): Promise<VerificationOutcome | null> {
    const staffTier = this.resourceResolver.resolveStaffTier(member);
    if (staffTier === null) {
      return null;
    }

    const expectedPrefix =
      this.resourceResolver.getPrefixForStaffTier(staffTier);
    const expectedNickname = InputValidator.rewriteStandardizedNicknamePrefix(
      member.nickname,
      this.appConfig.bot,
      expectedPrefix,
    );
    if (expectedNickname === null) {
      return null;
    }

    this.studentRepository.deleteByDiscordId(member.id);
    const targetRoles = MemberMutationHelper.getRoleIdsForStaffTransition(
      member,
      this.appConfig.permissions,
      "KEEP",
    );
    const hierarchyWarning = await this.syncStaffMemberIfNeeded(
      member,
      expectedNickname,
      targetRoles,
    );
    return {
      status: "ALREADY_ACTIVE",
      title: this.appConfig.messages.verificationAlreadyVerifiedTitle,
      description: `Your staff account is already verified and active.\n\nNickname: \`${expectedNickname}\``,
      appliedNickname: expectedNickname,
      nicknameHierarchyWarning: hierarchyWarning ?? undefined,
    };
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
    if (nicknameResult.reason === "NICKNAME_TOO_LONG") {
      Logger.warn(
        "VerificationController",
        "Verification rejected because formatted nickname exceeded limit",
        { discordId, studentId: rawStudentId },
      );
      return {
        status: "NICKNAME_TOO_LONG",
        title: this.appConfig.messages.verificationErrorTitle,
        description: nicknameResult.error,
      };
    }

    Logger.warn(
      "VerificationController",
      "Verification rejected due to invalid input",
      {
        discordId,
        reason: nicknameResult.reason,
      },
    );
    return {
      status: "INVALID_INPUT",
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
  private buildNewStudentRecord(
    discordId: string,
    studentId: string,
    fullName: string,
  ): Student {
    const defaultRound = this.appConfig.verification.defaultRound;
    return {
      studentId,
      fullName,
      discordId,
      isVerified: true,
      isRound1:
        defaultRound === "round-1" ||
        defaultRound === "round-2" ||
        defaultRound === "round-3",
      isRound2: defaultRound === "round-2" || defaultRound === "round-3",
      isRound3: defaultRound === "round-3",
    };
  }

  /**
   * Applies Discord nickname and roles for a new candidate or pre-assigned staff member.
   *
   * @param member the Discord guild member
   * @param studentRecord the validated Student identity fields
   * @param nickname the formatted candidate nickname
   * @returns a VERIFIED VerificationOutcome
   */
  private async commitNewStudentRegistration(
    member: GuildMember,
    studentRecord: Student,
    nickname: string,
  ): Promise<VerificationOutcome> {
    const staffTier = this.resourceResolver.resolveStaffTier(member);
    if (staffTier !== null) {
      return await this.commitPreAssignedStaffVerification(
        member,
        studentRecord,
        staffTier,
      );
    }

    const targetRoleIds = MemberMutationHelper.buildDesiredRoleIds(
      member,
      studentRecord,
      this.appConfig.permissions,
    );
    const hierarchyWarning =
      await MemberMutationHelper.applyMemberNicknameAndRoles(
        member,
        nickname,
        targetRoleIds,
        "VerificationController",
      );

    this.studentRepository.upsertStudent(studentRecord);
    Logger.info("VerificationController", "Registered new student", {
      discordId: member.id,
      studentId: studentRecord.studentId,
      fullName: studentRecord.fullName,
      nickname,
      defaultRound: this.appConfig.verification.defaultRound,
    });

    const verifiedRoleId = this.resourceResolver.getVerifiedRoleId();
    const activeRounds = this.formatActiveRoundsSummary(studentRecord);
    const roundLine =
      activeRounds !== "None" ? `\nUnlocked Rounds: ${activeRounds}` : "";
    return {
      status: "VERIFIED",
      title: this.appConfig.messages.verificationSuccessTitle,
      description: `Your identity has been verified.\n\nFull Name: \`${studentRecord.fullName}\`\nNickname: \`${nickname}\`\nStudent ID: \`${studentRecord.studentId}\`\nAssigned Role: <@&${verifiedRoleId}>${roundLine}`,
      student: studentRecord,
      appliedNickname: nickname,
      nicknameHierarchyWarning: hierarchyWarning ?? undefined,
    };
  }

  /**
   * Completes verification for a member pre-assigned moderator or supporter before verifying.
   *
   * @param member the Discord guild member
   * @param studentRecord the validated identity fields
   * @param staffTier the pre-assigned staff tier
   * @returns a VERIFIED VerificationOutcome reflecting staff promotion
   */
  private async commitPreAssignedStaffVerification(
    member: GuildMember,
    studentRecord: Student,
    staffTier: "MOD" | "SUP",
  ): Promise<VerificationOutcome> {
    const staffPrefix = this.resourceResolver.getPrefixForStaffTier(staffTier);
    const staffNickname = InputValidator.formatNickname(
      studentRecord.fullName,
      studentRecord.studentId,
      this.appConfig.bot,
      staffPrefix,
    );
    const targetRoleIds = MemberMutationHelper.getRoleIdsForStaffTransition(
      member,
      this.appConfig.permissions,
      "KEEP",
    );
    const hierarchyWarning =
      await MemberMutationHelper.applyMemberNicknameAndRoles(
        member,
        staffNickname,
        targetRoleIds,
        "VerificationController",
      );

    this.studentRepository.deleteByDiscordId(member.id);
    const staffRoleId =
      staffTier === "MOD"
        ? this.resourceResolver.getModeratorRoleId()
        : this.resourceResolver.getSupporterRoleId();

    Logger.info(
      "VerificationController",
      "Verified and promoted pre-assigned staff member",
      {
        discordId: member.id,
        studentId: studentRecord.studentId,
        staffTier,
        nickname: staffNickname,
      },
    );

    return {
      status: "VERIFIED",
      title: this.appConfig.messages.verificationSuccessTitle,
      description: `Your identity has been verified and updated for staff.\n\nFull Name: \`${studentRecord.fullName}\`\nNickname: \`${staffNickname}\`\nStudent ID: \`${studentRecord.studentId}\`\nStaff Role: <@&${staffRoleId}>`,
      appliedNickname: staffNickname,
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
    const missingRoles = desiredRoleIds.filter(
      (roleId) => !currentRoleIds.has(roleId),
    );
    const nicknameMatches =
      member.nickname === expectedNickname ||
      member.id === member.guild.ownerId;

    if (missingRoles.length === 0 && nicknameMatches) {
      Logger.debug(
        "VerificationController",
        "Member already verified and active",
        {
          discordId: member.id,
          studentId: student.studentId,
        },
      );
      return {
        status: "ALREADY_ACTIVE",
        title: this.appConfig.messages.verificationAlreadyVerifiedTitle,
        description: `Your account is already verified and active.\n\nFull Name: \`${student.fullName}\`\nNickname: \`${expectedNickname}\`\nStudent ID: \`${student.studentId}\``,
        student,
        appliedNickname: expectedNickname,
      };
    }

    const hierarchyWarning =
      await MemberMutationHelper.applyMemberNicknameAndRoles(
        member,
        expectedNickname,
        desiredRoleIds,
        "VerificationController",
      );

    Logger.info(
      "VerificationController",
      "Restored returning student roles and nickname",
      {
        discordId: member.id,
        studentId: student.studentId,
        restoredRolesCount: missingRoles.length,
      },
    );

    const restoredRounds = this.formatActiveRoundsSummary(student);
    return {
      status: "RESTORED",
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
    Logger.warn(
      "VerificationController",
      "Concurrent verification request blocked by mutex",
      {
        discordId,
      },
    );
    return {
      status: "LOCKED",
      title: "Verification In Progress",
      description:
        "Your previous verification request is still being processed. Please wait.",
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
      active.push(`<@&${this.resourceResolver.getRoundRoleId("round-1")}>`);
    }
    if (student.isRound2) {
      active.push(`<@&${this.resourceResolver.getRoundRoleId("round-2")}>`);
    }
    if (student.isRound3) {
      active.push(`<@&${this.resourceResolver.getRoundRoleId("round-3")}>`);
    }
    return active.length > 0 ? active.join(", ") : "None";
  }
}
