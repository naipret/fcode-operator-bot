/**
 * Validated recruitment stage identifier matching the three configured challenge roles.
 */
export type ChallengeStageKey = 'challenge-1' | 'challenge-2' | 'challenge-3';

/**
 * Domain entity representing a verified student persisted in the SQLite students table.
 */
export interface Student {
  studentId: string;
  fullName: string;
  discordId: string;
  isVerified: boolean;
  isChallenge1: boolean;
  isChallenge2: boolean;
  isChallenge3: boolean;
  teamName: string | null;
}

/**
 * Result status emitted by verification and rejoin restoration workflows.
 */
export type VerificationOutcomeStatus =
  | 'VERIFIED'
  | 'RESTORED'
  | 'ALREADY_ACTIVE'
  | 'GATE_CLOSED'
  | 'INVALID_INPUT'
  | 'NICKNAME_TOO_LONG'
  | 'CONFLICT'
  | 'LOCKED';

/**
 * Structured outcome returned by VerificationController after processing an action.
 */
export interface VerificationOutcome {
  status: VerificationOutcomeStatus;
  title: string;
  description: string;
  student?: Student;
  appliedNickname?: string;
  nicknameHierarchyWarning?: string;
}

/**
 * Summary report returned after bulk stage advancement or revocation commands.
 */
export interface BatchRoleMutationResult {
  targetedCount: number;
  updatedCount: number;
  skippedCount: number;
  failedMembers: string[];
}
