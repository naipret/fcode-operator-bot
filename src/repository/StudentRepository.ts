import type { ChallengeStageKey, Student } from '../model/Student.js';
import type { DatabaseClient } from './DatabaseClient.js';

/**
 * Raw row projection returned by SQLite queries on the students table.
 */
interface StudentRow {
  student_id: string;
  full_name: string;
  discord_id: string;
  is_verified: number;
  is_challenge_1: number;
  is_challenge_2: number;
  is_challenge_3: number;
}

/**
 * Provides parameterized SQLite CRUD and synchronization queries for students and settings.
 */
export class StudentRepository {
  private static readonly VERIFICATION_ENABLED_KEY = 'verification_enabled';
  private readonly databaseClient: DatabaseClient;

  /**
   * Creates a StudentRepository backed by the supplied DatabaseClient.
   *
   * @param databaseClient the initialized SQLite database client
   */
  public constructor(databaseClient: DatabaseClient) {
    this.databaseClient = databaseClient;
  }

  /**
   * Seeds the verification gate state in system_settings if no record exists yet.
   *
   * @param defaultEnabled the initial verification gate state from config.yaml
   */
  public seedVerificationGateDefault(defaultEnabled: boolean): void {
    const connection = this.databaseClient.getConnection();
    const statement = connection.prepare(`
      INSERT OR IGNORE INTO system_settings (setting_key, setting_value)
      VALUES (?, ?)
    `);
    statement.run(StudentRepository.VERIFICATION_ENABLED_KEY, defaultEnabled ? 'true' : 'false');
  }

  /**
   * Returns whether candidate verification is currently open.
   *
   * @returns true if new candidates are permitted to verify
   */
  public isVerificationEnabled(): boolean {
    const connection = this.databaseClient.getConnection();
    const row = connection
      .prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?')
      .get(StudentRepository.VERIFICATION_ENABLED_KEY) as { setting_value: string } | undefined;
    if (!row) {
      return true;
    }
    return row.setting_value === 'true';
  }

  /**
   * Persists the verification gate toggle value in system_settings.
   *
   * @param enabled true to open registration, false to close registration
   */
  public setVerificationEnabled(enabled: boolean): void {
    const connection = this.databaseClient.getConnection();
    connection
      .prepare(
        `
        INSERT INTO system_settings (setting_key, setting_value)
        VALUES (?, ?)
        ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value
      `,
      )
      .run(StudentRepository.VERIFICATION_ENABLED_KEY, enabled ? 'true' : 'false');
  }

  /**
   * Looks up a student record by uppercase student identifier.
   *
   * @param studentId the canonical uppercase student identifier
   * @returns the mapped Student entity or null when not found
   */
  public findByStudentId(studentId: string): Student | null {
    const connection = this.databaseClient.getConnection();
    const row = connection
      .prepare('SELECT * FROM students WHERE student_id = ?')
      .get(studentId.toUpperCase()) as StudentRow | undefined;
    return row ? this.mapRowToStudent(row) : null;
  }

  /**
   * Looks up a student record by Discord user snowflake identifier.
   *
   * @param discordId the Discord user snowflake identifier
   * @returns the mapped Student entity or null when not found
   */
  public findByDiscordId(discordId: string): Student | null {
    const connection = this.databaseClient.getConnection();
    const row = connection.prepare('SELECT * FROM students WHERE discord_id = ?').get(discordId) as
      StudentRow | undefined;
    return row ? this.mapRowToStudent(row) : null;
  }

  /**
   * Inserts a new verified student record or replaces an existing record by studentId.
   *
   * @param student the student domain object to persist
   */
  public upsertStudent(student: Student): void {
    const connection = this.databaseClient.getConnection();
    connection
      .prepare(
        `
        INSERT INTO students (
          student_id,
          full_name,
          discord_id,
          is_verified,
          is_challenge_1,
          is_challenge_2,
          is_challenge_3
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(student_id) DO UPDATE SET
          full_name = excluded.full_name,
          discord_id = excluded.discord_id,
          is_verified = excluded.is_verified,
          is_challenge_1 = excluded.is_challenge_1,
          is_challenge_2 = excluded.is_challenge_2,
          is_challenge_3 = excluded.is_challenge_3
      `,
      )
      .run(
        student.studentId,
        student.fullName,
        student.discordId,
        student.isVerified ? 1 : 0,
        student.isChallenge1 ? 1 : 0,
        student.isChallenge2 ? 1 : 0,
        student.isChallenge3 ? 1 : 0,
      );
  }

  /**
   * Deletes a student record by student identifier so the user can re-verify cleanly.
   *
   * @param studentId the uppercase student identifier to remove
   * @returns true if a row was deleted
   */
  public deleteByStudentId(studentId: string): boolean {
    const connection = this.databaseClient.getConnection();
    const result = connection
      .prepare('DELETE FROM students WHERE student_id = ?')
      .run(studentId.toUpperCase());
    return Number(result.changes) > 0;
  }

  /**
   * Deletes a student record by Discord user identifier.
   *
   * @param discordId the Discord user snowflake identifier
   * @returns true if a row was deleted
   */
  public deleteByDiscordId(discordId: string): boolean {
    const connection = this.databaseClient.getConnection();
    const result = connection.prepare('DELETE FROM students WHERE discord_id = ?').run(discordId);
    return Number(result.changes) > 0;
  }

  /**
   * Lists all students currently holding the specified challenge stage flag.
   *
   * @param stage the challenge stage column to filter by
   * @returns an array of matching Student entities
   */
  public listByChallengeStage(stage: ChallengeStageKey): Student[] {
    const column = this.resolveStageColumn(stage);
    const connection = this.databaseClient.getConnection();
    const rows = connection
      .prepare(`SELECT * FROM students WHERE is_verified = 1 AND ${column} = 1`)
      .all() as unknown as StudentRow[];
    return rows.map((row) => this.mapRowToStudent(row));
  }

  /**
   * Lists all verified students stored in SQLite for reconciliation with Discord.
   *
   * @returns an array of all verified Student entities
   */
  public listAllVerifiedStudents(): Student[] {
    const connection = this.databaseClient.getConnection();
    const rows = connection
      .prepare('SELECT * FROM students WHERE is_verified = 1')
      .all() as unknown as StudentRow[];
    return rows.map((row) => this.mapRowToStudent(row));
  }

  /**
   * Updates the challenge flags for an existing student.
   *
   * @param discordId the target student's Discord user identifier
   * @param state the synchronized role state flags
   */
  public syncRoleStateByDiscordId(
    discordId: string,
    state: {
      isChallenge1: boolean;
      isChallenge2: boolean;
      isChallenge3: boolean;
    },
  ): void {
    const connection = this.databaseClient.getConnection();
    connection
      .prepare(
        `
        UPDATE students
        SET is_challenge_1 = ?,
            is_challenge_2 = ?,
            is_challenge_3 = ?
        WHERE discord_id = ?
      `,
      )
      .run(
        state.isChallenge1 ? 1 : 0,
        state.isChallenge2 ? 1 : 0,
        state.isChallenge3 ? 1 : 0,
        discordId,
      );
  }

  /**
   * Sets a single challenge stage flag across multiple students inside an atomic transaction.
   *
   * @param studentIds the list of student identifiers to update
   * @param stage the challenge stage column to modify
   * @param value true to enable the stage flag, false to clear it
   */
  public setChallengeFlagForMany(
    studentIds: string[],
    stage: ChallengeStageKey,
    value: boolean,
  ): void {
    if (studentIds.length === 0) {
      return;
    }

    const column = this.resolveStageColumn(stage);
    const connection = this.databaseClient.getConnection();
    const statement = connection.prepare(`UPDATE students SET ${column} = ? WHERE student_id = ?`);

    this.databaseClient.runInTransaction(() => {
      for (const studentId of studentIds) {
        statement.run(value ? 1 : 0, studentId);
      }
    });
  }

  /**
   * Resolves a ChallengeStageKey literal to its corresponding SQLite column name.
   *
   * @param stage the challenge stage union value
   * @returns the exact SQLite column name
   */
  private resolveStageColumn(stage: ChallengeStageKey): string {
    switch (stage) {
      case 'challenge-1':
        return 'is_challenge_1';
      case 'challenge-2':
        return 'is_challenge_2';
      case 'challenge-3':
        return 'is_challenge_3';
    }
  }

  /**
   * Converts a raw SQLite row into a typed Student domain object.
   *
   * @param row the SQLite result row
   * @returns the mapped Student entity
   */
  private mapRowToStudent(row: StudentRow): Student {
    return {
      studentId: row.student_id,
      fullName: row.full_name,
      discordId: row.discord_id,
      isVerified: row.is_verified === 1,
      isChallenge1: row.is_challenge_1 === 1,
      isChallenge2: row.is_challenge_2 === 1,
      isChallenge3: row.is_challenge_3 === 1,
    };
  }
}
