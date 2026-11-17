import type { Guild, GuildMember } from 'discord.js';
import type { BatchRoleMutationResult, RoundKey, Student } from '../model/Student.js';
import type { StudentRepository } from '../repository/StudentRepository.js';
import type { GuildResourceResolver } from '../util/GuildResourceResolver.js';
import { InputValidator } from '../util/InputValidator.js';
import { Logger } from '../util/Logger.js';

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

  /**
   * Creates a RoundController bound to repository and guild resource resolver.
   *
   * @param studentRepository the SQLite student repository
   * @param resourceResolver the guild resource resolver
   */
  public constructor(
    studentRepository: StudentRepository,
    resourceResolver: GuildResourceResolver,
  ) {
    this.studentRepository = studentRepository;
    this.resourceResolver = resourceResolver;
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
    const desiredRoundIds = new Set<string>();
    if (toStage === 'round-1' || toStage === 'round-2' || toStage === 'round-3') {
      desiredRoundIds.add(round1Role.id);
    }
    if (toStage === 'round-2' || toStage === 'round-3') {
      desiredRoundIds.add(round2Role.id);
    }
    if (toStage === 'round-3') {
      desiredRoundIds.add(round3Role.id);
    }

    const updatedStudentIds: string[] = [];
    const failedMembers: string[] = [];
    let skippedCount = 0;

    for (const student of candidates) {
      const member = await guild.members.fetch(student.discordId).catch(() => null);
      if (!member) {
        failedMembers.push(`${student.studentId} (not in server)`);
        continue;
      }

      const dbMatches = this.doesStudentMatchStageFlags(student, toStage);
      const discordMatches = this.doesMemberMatchRoundRoles(
        member,
        managedRoundIds,
        desiredRoundIds,
      );

      if (dbMatches && discordMatches) {
        skippedCount += 1;
        continue;
      }

      try {
        if (!discordMatches) {
          const preservedIds = member.roles.cache
            .filter((role) => role.id !== guild.id && !managedRoundIds.has(role.id))
            .map((role) => role.id);
          await member.edit({ roles: Array.from(new Set([...preservedIds, ...desiredRoundIds])) });
        }
        updatedStudentIds.push(student.studentId);
      } catch (error) {
        Logger.warn(
          'RoundController',
          `Failed transitioning ${student.studentId} to ${toStage}: ${String(error)}`,
        );
        failedMembers.push(student.studentId);
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
   * Revokes a single round role from a resolved list of candidates on Discord and SQLite.
   *
   * @param guild the target Discord guild
   * @param candidates the resolved list of students to revoke from
   * @param round the round role to remove
   * @returns a summary BatchRoleMutationResult
   * @throws Error if the round role ID does not exist in the guild
   */
  public async revokeRoundFromCandidates(
    guild: Guild,
    candidates: Student[],
    round: RoundKey,
  ): Promise<BatchRoleMutationResult> {
    const roundRole = this.resourceResolver.getRoundRole(guild, round);
    if (!roundRole) {
      throw new Error(`Configured role for "${round}" was not found on the server.`);
    }

    const updatedStudentIds: string[] = [];
    const failedMembers: string[] = [];
    let skippedCount = 0;

    for (const student of candidates) {
      const member = await guild.members.fetch(student.discordId).catch(() => null);
      if (!member) {
        updatedStudentIds.push(student.studentId);
        continue;
      }
      if (!member.roles.cache.has(roundRole.id)) {
        updatedStudentIds.push(student.studentId);
        skippedCount += 1;
        continue;
      }
      try {
        await member.roles.remove(roundRole);
        updatedStudentIds.push(student.studentId);
      } catch (error) {
        Logger.warn(
          'RoundController',
          `Failed revoking ${round} from ${student.studentId}: ${String(error)}`,
        );
        failedMembers.push(student.studentId);
      }
    }

    this.studentRepository.setRoundFlagForMany(updatedStudentIds, round, false);

    return {
      targetedCount: candidates.length,
      updatedCount: updatedStudentIds.length - skippedCount,
      skippedCount,
      failedMembers,
    };
  }

  /**
   * Checks whether a student's SQLite round flags already match the target stage.
   *
   * @param student the student domain record
   * @param targetStage the target stage
   * @returns true if flags match
   */
  private doesStudentMatchStageFlags(student: Student, targetStage: StageKey): boolean {
    const expectR1 =
      targetStage === 'round-1' || targetStage === 'round-2' || targetStage === 'round-3';
    const expectR2 = targetStage === 'round-2' || targetStage === 'round-3';
    const expectR3 = targetStage === 'round-3';
    return (
      student.isRound1 === expectR1 &&
      student.isRound2 === expectR2 &&
      student.isRound3 === expectR3
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
