import type { Guild, GuildMember } from "discord.js";
import type { AppConfig } from "../config/ConfigSchema.js";
import type { Student } from "../model/Student.js";
import type { StudentRepository } from "../repository/StudentRepository.js";
import type { GuildResourceResolver } from "../util/GuildResourceResolver.js";
import { InputValidator } from "../util/InputValidator.js";
import { MemberMutationHelper } from "../util/MemberMutationHelper.js";

/**
 * Result returned by manual student lookup, register, update, and reset commands.
 */
export interface StudentActionOutcome {
  success: boolean;
  title: string;
  description: string;
  student?: Student;
}

/**
 * Explicit update payload for /student update supporting independent round flags.
 */
export interface StudentUpdateInput {
  fullName?: string | null;
  studentId?: string | null;
  isRound1: boolean;
  isRound2: boolean;
  isRound3: boolean;
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
 * Handles moderator and owner commands for inspecting, registering, updating, resetting, and syncing members.
 */
export class StudentController {
  private appConfig: AppConfig;
  private readonly studentRepository: StudentRepository;
  private readonly resourceResolver: GuildResourceResolver;
  private readonly lockedDiscordIds: Set<string>;

  /**
   * Creates a StudentController bound to configuration, repository, guild resolver, and lock set.
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
   * Looks up a student or staff record by @mention, Discord ID, or Student ID.
   *
   * @param target unified target identifier string
   * @returns a StudentActionOutcome containing the stored member details if found
   */
  public lookupStudent(target: string): StudentActionOutcome {
    const student = this.resolveStudentByTarget(target);
    if (!student) {
      return {
        success: false,
        title: "Student Not Found",
        description:
          "No student record matched the provided user or Student ID.",
      };
    }

    const prefixOverride = this.resolvePrefixFromRecord(student);
    const nickname = InputValidator.formatNickname(
      student.fullName,
      student.studentId,
      this.appConfig.bot,
      prefixOverride ?? undefined,
    );
    const rounds = this.formatActiveRounds(student);
    const staffSummary = this.formatStaffTierLabel(student);

    return {
      success: true,
      title: `Student Record: ${student.studentId}`,
      description: [
        `Discord User: <@${student.discordId}> (\`${student.discordId}\`)`,
        `Full Name: \`${student.fullName}\``,
        `Computed Nickname: \`${nickname}\``,
        `Role Tier: \`${staffSummary}\``,
        `Verified Candidate: \`${student.isVerified ? "Yes" : "No"}\``,
        `Active Rounds: ${rounds}`,
      ].join("\n"),
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
    const lockResult = await MemberMutationHelper.runWithMemberLock(
      this.lockedDiscordIds,
      member.id,
      () => this.executeManualRegistration(member, rawFullName, rawStudentId),
    );
    return lockResult.acquired ? lockResult.value : this.buildLockedOutcome();
  }

  /**
   * Updates an existing student's independent round flags and optional identity fields.
   *
   * @param guild the target Discord guild
   * @param target unified target string (@mention, Discord ID, or Student ID)
   * @param updates explicit round flags and optional name or student ID overrides
   * @returns a StudentActionOutcome describing the applied state
   */
  public async updateStudent(
    guild: Guild,
    target: string,
    updates: StudentUpdateInput,
  ): Promise<StudentActionOutcome> {
    const existingStudent = this.resolveStudentByTarget(target);
    if (!existingStudent) {
      return {
        success: false,
        title: "Student Not Found",
        description:
          "No student record matched the provided user or Student ID.",
      };
    }

    const lockResult = await MemberMutationHelper.runWithMemberLock(
      this.lockedDiscordIds,
      existingStudent.discordId,
      () => this.executeStudentUpdate(guild, existingStudent, updates),
    );
    return lockResult.acquired ? lockResult.value : this.buildLockedOutcome();
  }

  /**
   * Deletes a student record from SQLite and removes recruitment roles and nickname from Discord.
   *
   * @param guild the target Discord guild
   * @param target unified target string (@mention, Discord ID, or Student ID)
   * @returns a StudentActionOutcome summarizing the reset
   */
  public async resetStudent(
    guild: Guild,
    target: string,
  ): Promise<StudentActionOutcome> {
    const existingStudent = this.resolveStudentByTarget(target);
    if (!existingStudent) {
      return {
        success: false,
        title: "Student Not Found",
        description:
          "No student record matched the provided user or Student ID.",
      };
    }

    const lockResult = await MemberMutationHelper.runWithMemberLock(
      this.lockedDiscordIds,
      existingStudent.discordId,
      () => this.executeStudentReset(guild, existingStudent),
    );
    return lockResult.acquired ? lockResult.value : this.buildLockedOutcome();
  }

  /**
   * Promotes a verified member to moderator or supporter, or resets staff status with role:none.
   *
   * @param member the target Discord guild member
   * @param targetRole target staff role ("moderator" | "supporter" | "none")
   * @returns a StudentActionOutcome describing the applied staff transition
   */
  public async manageStaffRole(
    member: GuildMember,
    targetRole: "moderator" | "supporter" | "none",
  ): Promise<StudentActionOutcome> {
    const lockResult = await MemberMutationHelper.runWithMemberLock(
      this.lockedDiscordIds,
      member.id,
      () => this.executeManageStaffRole(member, targetRole),
    );
    return lockResult.acquired ? lockResult.value : this.buildLockedOutcome();
  }

  /**
   * Synchronizes active SQLite candidate and staff records (nicknames and roles) to Discord.
   *
   * @param guild the target Discord guild
   * @param target optional unified target string (@mention, Discord ID, or Student ID)
   * @returns a StudentSyncOutcome summarizing updated, skipped, and failed members
   */
  public async syncStudentsToDiscord(
    guild: Guild,
    target?: string | null,
  ): Promise<StudentSyncOutcome> {
    const targets = this.resolveSyncTargets(target);
    if (!targets) {
      return {
        success: false,
        title: "Student Not Found",
        description:
          "No active student or staff record matched the provided user or Student ID.",
        updatedCount: 0,
        skippedCount: 0,
        failedMembers: [],
      };
    }

    let updatedCount = 0;
    let skippedCount = 0;
    const failedMembers: string[] = [];

    for (const student of targets) {
      const outcome = await this.syncSingleStudent(guild, student);
      if (outcome === "UPDATED") {
        updatedCount += 1;
      } else if (outcome === "SKIPPED") {
        skippedCount += 1;
      } else {
        failedMembers.push(outcome);
      }
    }

    const failedSummary =
      failedMembers.length > 0
        ? `\nFailed (${String(failedMembers.length)}): \`${failedMembers.join(", ")}\``
        : "";

    return {
      success: true,
      title: "Database Sync Complete",
      description: `Reconciled \`${String(targets.length)}\` active record(s) between SQLite and Discord.\n\nUpdated: \`${String(updatedCount)}\`\nAlready In Sync: \`${String(skippedCount)}\`${failedSummary}`,
      updatedCount,
      skippedCount,
      failedMembers,
    };
  }

  /**
   * Executes manual registration validation, Discord update, and SQLite upsert under member lock.
   *
   * @param member the target Discord guild member
   * @param rawFullName the raw full name input
   * @param rawStudentId the raw student ID input
   * @returns a StudentActionOutcome
   */
  private async executeManualRegistration(
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
        title: "Invalid Student Information",
        description: validation.error,
      };
    }

    const existingById = this.studentRepository.findByStudentId(
      validation.studentId,
    );
    if (existingById && existingById.discordId !== member.id) {
      return {
        success: false,
        title: "Duplicate Student ID",
        description: `Student ID \`${validation.studentId}\` is already assigned to <@${existingById.discordId}>. Reset that record first before reassigning it.`,
      };
    }

    const existingByDiscord = this.studentRepository.findByDiscordId(member.id);
    if (
      existingByDiscord &&
      existingByDiscord.studentId !== validation.studentId
    ) {
      this.studentRepository.deleteByDiscordId(member.id);
    }

    const staffTier = this.resourceResolver.resolveStaffTier(member);
    if (staffTier !== null) {
      return await this.registerPreAssignedStaff(
        member,
        validation.studentId,
        validation.formattedFullName,
        staffTier,
      );
    }

    const student = this.buildManualStudentRecord(
      member.id,
      validation.studentId,
      validation.formattedFullName,
      existingByDiscord,
    );
    const roleIds = MemberMutationHelper.buildDesiredRoleIds(
      member,
      student,
      this.appConfig.permissions,
    );
    const hierarchyWarning =
      await MemberMutationHelper.applyMemberNicknameAndRoles(
        member,
        validation.nickname,
        roleIds,
        "StudentController",
      );

    this.studentRepository.upsertStudent(student);
    const warningNote = hierarchyWarning ? `\n\nNote: ${hierarchyWarning}` : "";

    return {
      success: true,
      title: "Student Registered Manually",
      description: `Updated <@${member.id}> successfully.\n\nFull Name: \`${student.fullName}\`\nNickname: \`${validation.nickname}\`\nStudent ID: \`${student.studentId}\`${warningNote}`,
      student,
    };
  }

  /**
   * Persists and applies staff profile when /student register targets a member with mod or sup roles.
   *
   * @param member the target Discord guild member
   * @param studentId validated uppercase student ID
   * @param fullName normalized Title Case full name
   * @param staffTier active staff tier on Discord
   * @returns a StudentActionOutcome
   */
  private async registerPreAssignedStaff(
    member: GuildMember,
    studentId: string,
    fullName: string,
    staffTier: "MOD" | "SUP",
  ): Promise<StudentActionOutcome> {
    const staffPrefix = this.resourceResolver.getPrefixForStaffTier(staffTier);
    const staffNickname = InputValidator.formatNickname(
      fullName,
      studentId,
      this.appConfig.bot,
      staffPrefix,
    );
    const staffRecord: Student = {
      studentId,
      fullName,
      discordId: member.id,
      isVerified: false,
      isRound1: false,
      isRound2: false,
      isRound3: false,
      isModerator: member.roles.cache.has(
        this.resourceResolver.getModeratorRoleId(),
      ),
      isSupporter: member.roles.cache.has(
        this.resourceResolver.getSupporterRoleId(),
      ),
    };
    const roleIds = MemberMutationHelper.getRoleIdsForStaffTransition(
      member,
      this.appConfig.permissions,
      "KEEP",
    );
    const hierarchyWarning =
      await MemberMutationHelper.applyMemberNicknameAndRoles(
        member,
        staffNickname,
        roleIds,
        "StudentController",
      );
    this.studentRepository.upsertStudent(staffRecord);
    const warningNote = hierarchyWarning ? `\n\nNote: ${hierarchyWarning}` : "";

    return {
      success: true,
      title: "Staff Registered Manually",
      description: `Updated <@${member.id}> as staff successfully.\n\nFull Name: \`${fullName}\`\nNickname: \`${staffNickname}\`\nStudent ID: \`${studentId}\`${warningNote}`,
      student: staffRecord,
    };
  }

  /**
   * Executes independent round and identity updates on SQLite and Discord under member lock.
   *
   * @param guild the target Discord guild
   * @param existingStudent the existing SQLite record
   * @param updates the requested update fields and explicit round booleans
   * @returns a StudentActionOutcome
   */
  private async executeStudentUpdate(
    guild: Guild,
    existingStudent: Student,
    updates: StudentUpdateInput,
  ): Promise<StudentActionOutcome> {
    const rawFullName = updates.fullName ?? existingStudent.fullName;
    const rawStudentId = updates.studentId ?? existingStudent.studentId;

    const validation = InputValidator.buildValidatedNickname(
      rawFullName,
      rawStudentId,
      this.appConfig.bot,
    );
    if (!validation.valid) {
      return {
        success: false,
        title: "Invalid Student Information",
        description: validation.error,
      };
    }

    const existingById = this.studentRepository.findByStudentId(
      validation.studentId,
    );
    if (existingById && existingById.discordId !== existingStudent.discordId) {
      return {
        success: false,
        title: "Duplicate Student ID",
        description: `Student ID \`${validation.studentId}\` is already assigned to <@${existingById.discordId}>. Reset that record first before reassigning it.`,
      };
    }

    const isStaff = existingStudent.isModerator || existingStudent.isSupporter;
    const updatedStudent: Student = {
      studentId: validation.studentId,
      fullName: validation.formattedFullName,
      discordId: existingStudent.discordId,
      isVerified: isStaff ? false : existingStudent.isVerified,
      isRound1: isStaff ? false : updates.isRound1,
      isRound2: isStaff ? false : updates.isRound2,
      isRound3: isStaff ? false : updates.isRound3,
      isModerator: existingStudent.isModerator,
      isSupporter: existingStudent.isSupporter,
    };

    const prefixOverride = this.resolvePrefixFromRecord(updatedStudent);
    const effectiveNickname = InputValidator.formatNickname(
      updatedStudent.fullName,
      updatedStudent.studentId,
      this.appConfig.bot,
      prefixOverride ?? undefined,
    );

    const discordNote = await this.applyUpdatedMemberState(
      guild,
      updatedStudent,
      effectiveNickname,
    );

    if (existingStudent.studentId !== updatedStudent.studentId) {
      this.studentRepository.deleteByDiscordId(existingStudent.discordId);
    }
    this.studentRepository.upsertStudent(updatedStudent);

    const activeRounds = this.formatActiveRounds(updatedStudent);
    return {
      success: true,
      title: "Student Updated",
      description: [
        `Updated <@${updatedStudent.discordId}> successfully.`,
        "",
        `Full Name: \`${updatedStudent.fullName}\``,
        `Nickname: \`${effectiveNickname}\``,
        `Student ID: \`${updatedStudent.studentId}\``,
        `Active Rounds: ${activeRounds}`,
        ...(discordNote ? ["", `Note: ${discordNote}`] : []),
      ].join("\n"),
      student: updatedStudent,
    };
  }

  /**
   * Applies updated nickname and roles to Discord if the member is currently in the guild.
   *
   * @param guild the target Discord guild
   * @param student the updated Student entity
   * @param nickname the formatted Discord nickname
   * @returns an optional notice string if the member left the server or hit hierarchy limits
   */
  private async applyUpdatedMemberState(
    guild: Guild,
    student: Student,
    nickname: string,
  ): Promise<string | null> {
    const member =
      guild.members.cache.get(student.discordId) ??
      (await guild.members.fetch(student.discordId).catch(() => null));
    if (!member) {
      return "Member is not currently in the server; changes are saved in SQLite and will apply on rejoin or sync.";
    }

    const roleIds =
      student.isModerator || student.isSupporter
        ? MemberMutationHelper.getRoleIdsForStaffTransition(
            member,
            this.appConfig.permissions,
            "KEEP",
          )
        : MemberMutationHelper.buildDesiredRoleIds(
            member,
            student,
            this.appConfig.permissions,
          );

    return await MemberMutationHelper.applyMemberNicknameAndRoles(
      member,
      nickname,
      roleIds,
      "StudentController",
    );
  }

  /**
   * Executes Discord role/nickname cleanup and deletes the student record under member lock.
   *
   * @param guild the target Discord guild
   * @param existingStudent the student record to remove
   * @returns a StudentActionOutcome
   */
  private async executeStudentReset(
    guild: Guild,
    existingStudent: Student,
  ): Promise<StudentActionOutcome> {
    const member = await guild.members
      .fetch(existingStudent.discordId)
      .catch(() => null);
    let discordCleanupNote = "";

    if (member) {
      const preservedRoles = MemberMutationHelper.getPreservedRoleIds(
        member,
        this.appConfig.permissions,
      );
      const hierarchyWarning =
        await MemberMutationHelper.applyMemberNicknameAndRoles(
          member,
          null,
          preservedRoles,
          "StudentController",
        );
      if (hierarchyWarning) {
        discordCleanupNote = `\n\nNote: ${hierarchyWarning}`;
      }
    }

    this.studentRepository.deleteByStudentId(existingStudent.studentId);

    return {
      success: true,
      title: "Student Reset Complete",
      description: `Removed database record \`${existingStudent.studentId}\` (<@${existingStudent.discordId}>). The user may now re-verify from scratch.${discordCleanupNote}`,
    };
  }

  /**
   * Executes staff promotion, role switching, or system-level staff reset under member lock.
   *
   * @param member the target Discord guild member
   * @param targetRole desired staff role or "none" to reset
   * @returns a StudentActionOutcome
   */
  private async executeManageStaffRole(
    member: GuildMember,
    targetRole: "moderator" | "supporter" | "none",
  ): Promise<StudentActionOutcome> {
    if (targetRole === "none") {
      this.studentRepository.deleteByDiscordId(member.id);
      const roleIds = MemberMutationHelper.getRoleIdsForStaffTransition(
        member,
        this.appConfig.permissions,
        "NONE",
      );
      const hierarchyWarning =
        await MemberMutationHelper.applyMemberNicknameAndRoles(
          member,
          null,
          roleIds,
          "StudentController",
        );
      const warningNote = hierarchyWarning
        ? `\n\nNote: ${hierarchyWarning}`
        : "";
      return {
        success: true,
        title: "Staff Reset Complete",
        description: `Cleared staff and recruitment roles, removed the SQLite record, and reset the nickname for <@${member.id}>. The user must \`/verify\` again to re-enter.${warningNote}`,
      };
    }

    const existingStudent = this.studentRepository.findByDiscordId(member.id);
    if (!existingStudent) {
      return {
        success: false,
        title: "Verification Required",
        description: `<@${member.id}> must complete \`/verify\` (or \`/student register\`) before being promoted to \`${targetRole}\`.`,
      };
    }

    const staffTier = targetRole === "moderator" ? "MOD" : "SUP";
    const targetPrefix = this.resourceResolver.getPrefixForStaffTier(staffTier);
    const staffNickname = InputValidator.formatNickname(
      existingStudent.fullName,
      existingStudent.studentId,
      this.appConfig.bot,
      targetPrefix,
    );

    const updatedRecord: Student = {
      ...existingStudent,
      isVerified: false,
      isRound1: false,
      isRound2: false,
      isRound3: false,
      isModerator: targetRole === "moderator",
      isSupporter: targetRole === "supporter",
    };

    const roleIds = MemberMutationHelper.getRoleIdsForStaffTransition(
      member,
      this.appConfig.permissions,
      staffTier,
    );
    const hierarchyWarning =
      await MemberMutationHelper.applyMemberNicknameAndRoles(
        member,
        staffNickname,
        roleIds,
        "StudentController",
      );

    this.studentRepository.upsertStudent(updatedRecord);
    const targetRoleId =
      staffTier === "MOD"
        ? this.resourceResolver.getModeratorRoleId()
        : this.resourceResolver.getSupporterRoleId();
    const warningNote = hierarchyWarning ? `\n\nNote: ${hierarchyWarning}` : "";

    return {
      success: true,
      title: "Staff Role Updated",
      description: `Assigned <@&${targetRoleId}> to <@${member.id}>, cleared candidate roles, and updated nickname to \`${staffNickname}\`.${warningNote}`,
      student: updatedRecord,
    };
  }

  /**
   * Resolves the list of active candidate and staff records targeted by syncStudentsToDiscord.
   *
   * @param target optional unified target string
   * @returns array of Student records or null if a specific target was not found
   */
  private resolveSyncTargets(target?: string | null): Student[] | null {
    if (target && target.trim().length > 0) {
      const matched = this.resolveStudentByTarget(target);
      if (!matched) {
        return null;
      }
      const isActive =
        matched.isVerified || matched.isModerator || matched.isSupporter;
      return isActive ? [matched] : null;
    }
    return this.studentRepository.listAllActiveMembers();
  }

  /**
   * Reconciles a single SQLite record with Discord under per-member lock.
   *
   * @param guild the target Discord guild
   * @param student the stored Student record
   * @returns 'UPDATED', 'SKIPPED', or a descriptive failure label
   */
  private async syncSingleStudent(
    guild: Guild,
    student: Student,
  ): Promise<string> {
    const lockResult = await MemberMutationHelper.runWithMemberLock(
      this.lockedDiscordIds,
      student.discordId,
      () => this.reconcileStudentMember(guild, student),
    );
    return lockResult.acquired
      ? lockResult.value
      : `${student.studentId} (locked)`;
  }

  /**
   * Reconciles a stored candidate or staff member with live Discord staff roles and nicknames.
   *
   * @param guild the target Discord guild
   * @param student the stored Student record
   * @returns 'UPDATED', 'SKIPPED', or a descriptive failure label
   */
  private async reconcileStudentMember(
    guild: Guild,
    student: Student,
  ): Promise<string> {
    const member =
      guild.members.cache.get(student.discordId) ??
      (await guild.members.fetch(student.discordId).catch(() => null));
    if (!member) {
      return `${student.studentId} (not in server)`;
    }

    const liveStaffTier = this.resourceResolver.resolveStaffTier(member);
    if (liveStaffTier !== null) {
      return await this.reconcileStaffMember(member, student, liveStaffTier);
    }

    if (student.isModerator || student.isSupporter) {
      this.studentRepository.deleteByDiscordId(member.id);
      const preservedRoles = MemberMutationHelper.getPreservedRoleIds(
        member,
        this.appConfig.permissions,
      );
      await MemberMutationHelper.applyMemberNicknameAndRoles(
        member,
        null,
        preservedRoles,
        "StudentController",
      );
      return "UPDATED";
    }

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
    return await this.applyReconciledProfileIfChanged(
      member,
      expectedNickname,
      desiredRoleIds,
    );
  }

  /**
   * Synchronizes offline staff promotions or prefix changes between Discord and SQLite.
   *
   * @param member the live Discord guild member
   * @param student the stored SQLite record
   * @param staffTier active staff tier on Discord
   * @returns 'UPDATED' or 'SKIPPED'
   */
  private async reconcileStaffMember(
    member: GuildMember,
    student: Student,
    staffTier: "MOD" | "SUP",
  ): Promise<string> {
    const hasMod = member.roles.cache.has(
      this.resourceResolver.getModeratorRoleId(),
    );
    const hasSup = member.roles.cache.has(
      this.resourceResolver.getSupporterRoleId(),
    );
    const dbMatches =
      !student.isVerified &&
      !student.isRound1 &&
      !student.isRound2 &&
      !student.isRound3 &&
      student.isModerator === hasMod &&
      student.isSupporter === hasSup;

    if (!dbMatches) {
      this.studentRepository.upsertStudent({
        ...student,
        isVerified: false,
        isRound1: false,
        isRound2: false,
        isRound3: false,
        isModerator: hasMod,
        isSupporter: hasSup,
      });
    }

    const staffPrefix = this.resourceResolver.getPrefixForStaffTier(staffTier);
    const expectedNickname = InputValidator.formatNickname(
      student.fullName,
      student.studentId,
      this.appConfig.bot,
      staffPrefix,
    );
    const desiredRoleIds = MemberMutationHelper.getRoleIdsForStaffTransition(
      member,
      this.appConfig.permissions,
      "KEEP",
    );

    const profileOutcome = await this.applyReconciledProfileIfChanged(
      member,
      expectedNickname,
      desiredRoleIds,
    );
    return !dbMatches || profileOutcome === "UPDATED" ? "UPDATED" : "SKIPPED";
  }

  /**
   * Compares current Discord nickname and roles against desired state and mutates only if changed.
   *
   * @param member the target Discord guild member
   * @param expectedNickname desired server nickname
   * @param desiredRoleIds desired Discord role Snowflake IDs
   * @returns 'UPDATED' or 'SKIPPED'
   */
  private async applyReconciledProfileIfChanged(
    member: GuildMember,
    expectedNickname: string,
    desiredRoleIds: string[],
  ): Promise<string> {
    const currentRoleIds = new Set(
      member.roles.cache
        .filter((role) => role.id !== member.guild.id)
        .map((role) => role.id),
    );
    const rolesMatch =
      desiredRoleIds.length === currentRoleIds.size &&
      desiredRoleIds.every((roleId) => currentRoleIds.has(roleId));
    const nicknameMatches =
      member.nickname === expectedNickname ||
      member.id === member.guild.ownerId;

    if (rolesMatch && nicknameMatches) {
      return "SKIPPED";
    }

    await MemberMutationHelper.applyMemberNicknameAndRoles(
      member,
      expectedNickname,
      desiredRoleIds,
      "StudentController",
    );
    return "UPDATED";
  }

  /**
   * Builds a Student record for manual registration, preserving existing round flags when present.
   *
   * @param discordId the target Discord user ID
   * @param studentId the validated uppercase student ID
   * @param fullName the normalized Title Case full name
   * @param existingByDiscord existing Student record matched by Discord ID, if any
   * @returns the constructed Student entity
   */
  private buildManualStudentRecord(
    discordId: string,
    studentId: string,
    fullName: string,
    existingByDiscord: Student | null,
  ): Student {
    const defaultRound = this.appConfig.verification.defaultRound;
    return {
      studentId,
      fullName,
      discordId,
      isVerified: true,
      isRound1: existingByDiscord
        ? existingByDiscord.isRound1
        : defaultRound === "round-1" ||
          defaultRound === "round-2" ||
          defaultRound === "round-3",
      isRound2: existingByDiscord
        ? existingByDiscord.isRound2
        : defaultRound === "round-2" || defaultRound === "round-3",
      isRound3: existingByDiscord
        ? existingByDiscord.isRound3
        : defaultRound === "round-3",
      isModerator: false,
      isSupporter: false,
    };
  }

  /**
   * Resolves the nickname prefix override from stored staff flags when present.
   *
   * @param student the stored Student entity
   * @returns moderatorPrefix, supporterPrefix, or null for candidates
   */
  private resolvePrefixFromRecord(student: Student): string | null {
    if (student.isModerator) {
      return this.appConfig.bot.moderatorPrefix;
    }
    if (student.isSupporter) {
      return this.appConfig.bot.supporterPrefix;
    }
    return null;
  }

  /**
   * Formats a human-readable role tier label from stored flags.
   *
   * @param student the stored Student entity
   * @returns role tier summary label
   */
  private formatStaffTierLabel(student: Student): string {
    if (student.isModerator && student.isSupporter) {
      return "Moderator + Supporter";
    }
    if (student.isModerator) {
      return "Moderator";
    }
    if (student.isSupporter) {
      return "Supporter";
    }
    return "Candidate";
  }

  /**
   * Formats active round flags into Discord role mentions or "None".
   *
   * @param student the student domain entity
   * @returns formatted active round string
   */
  private formatActiveRounds(student: Student): string {
    const rounds = [
      student.isRound1
        ? `<@&${this.resourceResolver.getRoundRoleId("round-1")}>`
        : null,
      student.isRound2
        ? `<@&${this.resourceResolver.getRoundRoleId("round-2")}>`
        : null,
      student.isRound3
        ? `<@&${this.resourceResolver.getRoundRoleId("round-3")}>`
        : null,
    ].filter((entry): entry is string => entry !== null);

    return rounds.length > 0 ? rounds.join(", ") : "None";
  }

  /**
   * Builds a standardized failure outcome when a member is locked by another concurrent operation.
   *
   * @returns a StudentActionOutcome indicating an active lock
   */
  private buildLockedOutcome(): StudentActionOutcome {
    return {
      success: false,
      title: "Operation In Progress",
      description:
        "Another operation is currently updating this member. Please try again shortly.",
    };
  }
}
