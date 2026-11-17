import type { Guild, GuildMember, Role } from 'discord.js';
import type { BatchRoleMutationResult, RoundKey, Student } from '../model/Student.js';
import type { StudentRepository } from '../repository/StudentRepository.js';
import type { GuildResourceResolver } from '../util/GuildResourceResolver.js';
import { InputValidator } from '../util/InputValidator.js';
import { Logger } from '../util/Logger.js';
import { MemberMutationHelper } from '../util/MemberMutationHelper.js';

/**
 * All recruitment stages eligible as source or target for /round promote.
 */
export type StageKey = 'verified' | RoundKey;

/**
 * Coordinates owner-only recruitment round transitions and bulk role revocation.
 */
export class RoundController {
  private readonly studentRepository: StudentRepository;
  private readonly resourceResolver: GuildResourceResolver;
  private readonly lockedDiscordIds: Set<string>;

  /**
   * Creates a RoundController bound to repository, guild resource resolver, and member lock set.
   *
   * @param studentRepository the SQLite student repository
   * @param resourceResolver the guild resource resolver
   * @param lockedDiscordIds shared Set tracking members currently mutated by the bot
   */
  public constructor(
    studentRepository: StudentRepository,
    resourceResolver: GuildResourceResolver,
    lockedDiscordIds: Set<string>,
  ) {
    this.studentRepository = studentRepository;
    this.resourceResolver = resourceResolver;
    this.lockedDiscordIds = lockedDiscordIds;
  }

  /**
   * Resolves eligible students holding sourceStage and filters them by exclude or only targets.
   *
   * @param sourceStage the starting stage ('verified', 'round-1', 'round-2', or 'round-3')
   * @param excludeInput optional string of mentions or student IDs to exclude
   * @param onlyInput optional string of mentions or student IDs to include exclusively
   * @returns filtered array of eligible Student records
   */
  public resolveCandidates(
    sourceStage: StageKey,
    excludeInput?: string | null,
    onlyInput?: string | null,
  ): Student[] {
    const sourceStudents =
      sourceStage === 'verified'
        ? this.studentRepository.listAllVerifiedStudents()
        : this.studentRepository.listByRound(sourceStage);

    return this.filterStudentsByTargetStrings(sourceStudents, excludeInput, onlyInput);
  }

  /**
   * Resolves eligible verified students holding at least one of the specified rounds.
   *
   * @param rounds the round keys to match
   * @param excludeInput optional string of mentions or student IDs to exclude
   * @param onlyInput optional string of mentions or student IDs to include exclusively
   * @returns filtered array of eligible Student records
   */
  public resolveCandidatesForRounds(
    rounds: RoundKey[],
    excludeInput?: string | null,
    onlyInput?: string | null,
  ): Student[] {
    const sourceStudents = this.studentRepository.listByAnyRound(rounds);
    return this.filterStudentsByTargetStrings(sourceStudents, excludeInput, onlyInput);
  }

  /**
   * Transitions eligible students from any source stage to any target stage (forward or backward).
   *
   * @param guild the target Discord guild
   * @param candidates the resolved list of students to transition
   * @param toStage the destination stage ('verified' or 'round-1' | 'round-2' | 'round-3')
   * @returns a summary BatchRoleMutationResult
   * @throws Error if any configured round role is missing on the server
   */
  public async transitionStudents(
    guild: Guild,
    candidates: Student[],
    toStage: StageKey,
  ): Promise<BatchRoleMutationResult> {
    const round1Role = this.resourceResolver.getRoundRole(guild, 'round-1');
    const round2Role = this.resourceResolver.getRoundRole(guild, 'round-2');
    const round3Role = this.resourceResolver.getRoundRole(guild, 'round-3');
    if (!round1Role || !round2Role || !round3Role) {
      throw new Error('One or more configured round roles were not found on the server.');
    }

    const managedRoundIds = new Set<string>([round1Role.id, round2Role.id, round3Role.id]);
    const desiredRoundIds = this.buildDesiredRoundRoleIds(
      toStage,
      round1Role.id,
      round2Role.id,
      round3Role.id,
    );

    const updatedStudentIds: string[] = [];
    const failedMembers: string[] = [];
    let skippedCount = 0;

    for (const student of candidates) {
      const outcome = await this.transitionSingleStudent(
        guild,
        student,
        toStage,
        managedRoundIds,
        desiredRoundIds,
      );
      if (outcome === 'UPDATED') {
        updatedStudentIds.push(student.studentId);
      } else if (outcome === 'SKIPPED') {
        skippedCount += 1;
      } else {
        failedMembers.push(outcome);
      }
    }

    this.studentRepository.applyRoundTransitionForMany(updatedStudentIds, toStage);

    return {
      targetedCount: candidates.length,
      updatedCount: updatedStudentIds.length,
      skippedCount,
      failedMembers,
    };
  }

  /**
   * Revokes one or more round roles from a resolved list of candidates on Discord and SQLite.
   *
   * @param guild the target Discord guild
   * @param candidates the resolved list of students to revoke from
   * @param rounds the round roles to remove
   * @returns a summary BatchRoleMutationResult
   * @throws Error if any configured round role ID does not exist in the guild
   */
  public async revokeRoundsFromCandidates(
    guild: Guild,
    candidates: Student[],
    rounds: RoundKey[],
  ): Promise<BatchRoleMutationResult> {
    const targetRoles: Role[] = [];
    for (const round of rounds) {
      const roundRole = this.resourceResolver.getRoundRole(guild, round);
      if (!roundRole) {
        throw new Error(`Configured role for "${round}" was not found on the server.`);
      }
      targetRoles.push(roundRole);
    }

    const targetRoleIds = new Set(targetRoles.map((role) => role.id));
    const updatedStudentIds: string[] = [];
    const failedMembers: string[] = [];
    let skippedCount = 0;

    for (const student of candidates) {
      const outcome = await this.revokeSingleStudentRoles(guild, student, targetRoleIds, rounds);
      if (outcome === 'UPDATED') {
        updatedStudentIds.push(student.studentId);
      } else if (outcome === 'SKIPPED') {
        updatedStudentIds.push(student.studentId);
        skippedCount += 1;
      } else {
        failedMembers.push(outcome);
      }
    }

    this.studentRepository.clearRoundFlagsForMany(updatedStudentIds, rounds);

    return {
      targetedCount: candidates.length,
      updatedCount: updatedStudentIds.length - skippedCount,
      skippedCount,
      failedMembers,
    };
  }

  /**
   * Applies exclude or only target filters to a source list of students.
   *
   * @param sourceStudents the unfiltered list of students
   * @param excludeInput optional string of mentions or student IDs to exclude
   * @param onlyInput optional string of mentions or student IDs to include exclusively
   * @returns filtered Student array
   */
  private filterStudentsByTargetStrings(
    sourceStudents: Student[],
    excludeInput?: string | null,
    onlyInput?: string | null,
  ): Student[] {
    if (onlyInput && onlyInput.trim().length > 0) {
      const onlyTokens = InputValidator.parseTargetTokens(onlyInput);
      const allowedDiscordIds = new Set(onlyTokens.discordIds);
      const allowedStudentIds = new Set(onlyTokens.studentIds);
      return sourceStudents.filter(
        (student) =>
          allowedDiscordIds.has(student.discordId) || allowedStudentIds.has(student.studentId),
      );
    }

    if (excludeInput && excludeInput.trim().length > 0) {
      const excludeTokens = InputValidator.parseTargetTokens(excludeInput);
      const excludedDiscordIds = new Set(excludeTokens.discordIds);
      const excludedStudentIds = new Set(excludeTokens.studentIds);
      return sourceStudents.filter(
        (student) =>
          !excludedDiscordIds.has(student.discordId) && !excludedStudentIds.has(student.studentId),
      );
    }

    return sourceStudents;
  }

  /**
   * Transitions a single student's Discord round roles under per-member lock.
   *
   * @param guild the target Discord guild
   * @param student the student record
   * @param toStage destination stage
   * @param managedRoundIds all managed round role IDs
   * @param desiredRoundIds target round role IDs for toStage
   * @returns 'UPDATED', 'SKIPPED', or a descriptive failure string
   */
  private async transitionSingleStudent(
    guild: Guild,
    student: Student,
    toStage: StageKey,
    managedRoundIds: Set<string>,
    desiredRoundIds: Set<string>,
  ): Promise<string> {
    const lockResult = await MemberMutationHelper.runWithMemberLock(
      this.lockedDiscordIds,
      student.discordId,
      async () => {
        const member =
          guild.members.cache.get(student.discordId) ??
          (await guild.members.fetch(student.discordId).catch(() => null));
        if (!member) {
          return `${student.studentId} (not in server)`;
        }

        const databaseMatches = this.doesStudentMatchStageFlags(student, toStage);
        const discordMatches = this.doesMemberMatchRoundRoles(
          member,
          managedRoundIds,
          desiredRoundIds,
        );
        if (databaseMatches && discordMatches) {
          return 'SKIPPED';
        }

        if (!discordMatches) {
          const preservedIds = member.roles.cache
            .filter((role) => role.id !== guild.id && !managedRoundIds.has(role.id))
            .map((role) => role.id);
          await member.edit({ roles: Array.from(new Set([...preservedIds, ...desiredRoundIds])) });
        }
        return 'UPDATED';
      },
    ).catch((error: unknown) => {
      Logger.warn(
        'RoundController',
        `Failed transitioning ${student.studentId} to ${toStage}: ${String(error)}`,
      );
      return { acquired: true as const, value: student.studentId };
    });

    return lockResult.acquired ? lockResult.value : `${student.studentId} (locked)`;
  }

  /**
   * Removes target round roles from a single Discord member under per-member lock.
   *
   * @param guild the target Discord guild
   * @param student the student record
   * @param targetRoleIds role IDs to remove
   * @param rounds round keys being cleared
   * @returns 'UPDATED', 'SKIPPED', or a descriptive failure string
   */
  private async revokeSingleStudentRoles(
    guild: Guild,
    student: Student,
    targetRoleIds: Set<string>,
    rounds: RoundKey[],
  ): Promise<string> {
    const lockResult = await MemberMutationHelper.runWithMemberLock(
      this.lockedDiscordIds,
      student.discordId,
      async () => {
        const member =
          guild.members.cache.get(student.discordId) ??
          (await guild.members.fetch(student.discordId).catch(() => null));
        if (!member) {
          return 'UPDATED';
        }

        const hasTargetRole = member.roles.cache.some((role) => targetRoleIds.has(role.id));
        if (!hasTargetRole) {
          return 'SKIPPED';
        }

        const nextRoleIds = member.roles.cache
          .filter((role) => role.id !== guild.id && !targetRoleIds.has(role.id))
          .map((role) => role.id);
        await member.edit({ roles: nextRoleIds });
        return 'UPDATED';
      },
    ).catch((error: unknown) => {
      Logger.warn(
        'RoundController',
        `Failed revoking ${rounds.join(', ')} from ${student.studentId}: ${String(error)}`,
      );
      return { acquired: true as const, value: student.studentId };
    });

    return lockResult.acquired ? lockResult.value : `${student.studentId} (locked)`;
  }

  /**
   * Computes cumulative round role IDs corresponding to a destination stage.
   *
   * @param toStage destination stage
   * @param round1Id Discord role ID for round-1
   * @param round2Id Discord role ID for round-2
   * @param round3Id Discord role ID for round-3
   * @returns Set of desired round role IDs
   */
  private buildDesiredRoundRoleIds(
    toStage: StageKey,
    round1Id: string,
    round2Id: string,
    round3Id: string,
  ): Set<string> {
    const desiredRoundIds = new Set<string>();
    if (toStage === 'round-1' || toStage === 'round-2' || toStage === 'round-3') {
      desiredRoundIds.add(round1Id);
    }
    if (toStage === 'round-2' || toStage === 'round-3') {
      desiredRoundIds.add(round2Id);
    }
    if (toStage === 'round-3') {
      desiredRoundIds.add(round3Id);
    }
    return desiredRoundIds;
  }

  /**
   * Checks whether a student's SQLite round flags already match the target stage.
   *
   * @param student the student domain record
   * @param targetStage the target stage
   * @returns true if flags match
   */
  private doesStudentMatchStageFlags(student: Student, targetStage: StageKey): boolean {
    const expectRound1 =
      targetStage === 'round-1' || targetStage === 'round-2' || targetStage === 'round-3';
    const expectRound2 = targetStage === 'round-2' || targetStage === 'round-3';
    const expectRound3 = targetStage === 'round-3';
    return (
      student.isRound1 === expectRound1 &&
      student.isRound2 === expectRound2 &&
      student.isRound3 === expectRound3
    );
  }

  /**
   * Checks whether a Discord member's current round roles match the desired round role set.
   *
   * @param member the Discord guild member
   * @param managedRoundIds all managed round role IDs
   * @param desiredRoundIds desired round role IDs
   * @returns true if member holds the exact desired subset of managed round roles
   */
  private doesMemberMatchRoundRoles(
    member: GuildMember,
    managedRoundIds: Set<string>,
    desiredRoundIds: Set<string>,
  ): boolean {
    for (const roleId of managedRoundIds) {
      const hasRole = member.roles.cache.has(roleId);
      const shouldHave = desiredRoundIds.has(roleId);
      if (hasRole !== shouldHave) {
        return false;
      }
    }
    return true;
  }
}
