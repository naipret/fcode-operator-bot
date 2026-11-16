import type { Guild } from 'discord.js';
import type { BatchRoleMutationResult, RoundKey, Student } from '../model/Student.js';
import type { StudentRepository } from '../repository/StudentRepository.js';
import type { GuildResourceResolver } from '../util/GuildResourceResolver.js';
import { InputValidator } from '../util/InputValidator.js';
import { Logger } from '../util/Logger.js';

/**
 * Coordinates owner-only recruitment round promotion, bulk role revocation, and gate toggling.
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
   * Enables or disables new candidate registrations via the SQLite gate setting.
   *
   * @param enabled true to open registration, false to close registration
   * @returns the persisted gate state
   */
  public setVerificationEnabled(enabled: boolean): boolean {
    this.studentRepository.setVerificationEnabled(enabled);
    return enabled;
  }

  /**
   * Lists eligible students who hold the source round role and filters them by exclude or only targets.
   *
   * @param sourceRound the starting round key ('round-1' or 'round-2')
   * @param excludeInput optional string of mentions or student IDs to exclude
   * @param onlyInput optional string of mentions or student IDs to include exclusively
   * @returns filtered array of eligible Student records
   */
  public resolveCandidatesForAdvance(
    sourceRound: RoundKey,
    excludeInput?: string | null,
    onlyInput?: string | null,
  ): Student[] {
    const sourceStudents = this.studentRepository.listByRound(sourceRound);

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
   * Resolves the target round from explicit option or default sequential progression.
   *
   * @param fromRound the source round ('round-1' or 'round-2')
   * @param toRound optional override round ('round-2' or 'round-3')
   * @returns the target RoundKey or null if invalid progression
   */
  public resolveTargetRound(
    fromRound: 'round-1' | 'round-2',
    toRound: 'round-2' | 'round-3' | null,
  ): 'round-2' | 'round-3' | null {
    if (!toRound) {
      return fromRound === 'round-1' ? 'round-2' : 'round-3';
    }
    if (fromRound === 'round-2' && toRound !== 'round-3') {
      return null;
    }
    return toRound;
  }

  /**
   * Promotes eligible students to targetRound on both Discord and SQLite.
   *
   * @param guild the target Discord guild
   * @param candidates the resolved list of students to promote
   * @param targetRound the destination round ('round-2' or 'round-3')
   * @returns a summary BatchRoleMutationResult
   * @throws Error if the target round role ID does not exist in the guild
   */
  public async advanceStudentsToRound(
    guild: Guild,
    candidates: Student[],
    targetRound: 'round-2' | 'round-3',
  ): Promise<BatchRoleMutationResult> {
    const targetRole = this.resourceResolver.getRoundRole(guild, targetRound);
    if (!targetRole) {
      throw new Error(`Configured role for "${targetRound}" was not found on the server.`);
    }

    const updatedStudentIds: string[] = [];
    const failedMembers: string[] = [];
    let skippedCount = 0;

    for (const student of candidates) {
      const alreadyHasFlag = targetRound === 'round-2' ? student.isRound2 : student.isRound3;
      const member = await guild.members.fetch(student.discordId).catch(() => null);
      if (!member) {
        failedMembers.push(`${student.studentId} (not in server)`);
        continue;
      }

      const alreadyHasDiscordRole = member.roles.cache.has(targetRole.id);
      if (alreadyHasFlag && alreadyHasDiscordRole) {
        skippedCount += 1;
        continue;
      }

      try {
        if (!alreadyHasDiscordRole) {
          await member.roles.add(targetRole);
        }
        updatedStudentIds.push(student.studentId);
      } catch (error) {
        Logger.warn('RoundController', `Failed advancing ${student.studentId}: ${String(error)}`);
        failedMembers.push(student.studentId);
      }
    }

    this.studentRepository.setRoundFlagForMany(updatedStudentIds, targetRound, true);

    return {
      targetedCount: candidates.length,
      updatedCount: updatedStudentIds.length,
      skippedCount,
      failedMembers,
    };
  }

  /**
   * Revokes a round role from multiple members identified by Discord IDs or student IDs.
   *
   * @param guild the target Discord guild
   * @param round the round role to remove
   * @param targetDiscordIds array of Discord user IDs
   * @param targetStudentIds array of uppercase student IDs
   * @returns a summary BatchRoleMutationResult
   * @throws Error if the round role ID does not exist in the guild
   */
  public async revokeRoundRoleFromTargets(
    guild: Guild,
    round: RoundKey,
    targetDiscordIds: string[],
    targetStudentIds: string[],
  ): Promise<BatchRoleMutationResult> {
    const roundRole = this.resourceResolver.getRoundRole(guild, round);
    if (!roundRole) {
      throw new Error(`Configured role for "${round}" was not found on the server.`);
    }

    const resolvedStudents = this.resolveStudentsFromMixedTargets(
      targetDiscordIds,
      targetStudentIds,
    );
    const matchedDiscordIds = new Set(resolvedStudents.map((student) => student.discordId));
    const directDiscordIds = targetDiscordIds.filter((id) => !matchedDiscordIds.has(id));

    const updatedStudentIds: string[] = [];
    const failedMembers: string[] = [];
    let skippedCount = 0;

    for (const student of resolvedStudents) {
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

    for (const discordId of directDiscordIds) {
      const member = await guild.members.fetch(discordId).catch(() => null);
      if (!member || !member.roles.cache.has(roundRole.id)) {
        skippedCount += 1;
        continue;
      }
      try {
        await member.roles.remove(roundRole);
      } catch {
        failedMembers.push(discordId);
      }
    }

    this.studentRepository.setRoundFlagForMany(updatedStudentIds, round, false);

    return {
      targetedCount: resolvedStudents.length + directDiscordIds.length,
      updatedCount: updatedStudentIds.length - skippedCount,
      skippedCount,
      failedMembers,
    };
  }

  /**
   * Resolves unique Student records from combined Discord ID and Student ID inputs.
   *
   * @param discordIds list of Discord user snowflake IDs
   * @param studentIds list of uppercase student IDs
   * @returns deduplicated array of found Student records
   */
  private resolveStudentsFromMixedTargets(discordIds: string[], studentIds: string[]): Student[] {
    const studentMap = new Map<string, Student>();

    for (const discordId of discordIds) {
      const found = this.studentRepository.findByDiscordId(discordId);
      if (found) {
        studentMap.set(found.studentId, found);
      }
    }

    for (const studentId of studentIds) {
      const found = this.studentRepository.findByStudentId(studentId);
      if (found) {
        studentMap.set(found.studentId, found);
      }
    }

    return Array.from(studentMap.values());
  }
}
