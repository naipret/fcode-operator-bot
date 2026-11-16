import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Manages the built-in node:sqlite connection, runtime directory creation, and schema bootstrap.
 */
export class DatabaseClient {
  private readonly database: DatabaseSync;

  /**
   * Opens the SQLite database file or in-memory store, enables WAL mode, and ensures tables exist.
   *
   * @param databasePath filesystem path for the SQLite file or ":memory:" for isolated checks
   */
  public constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      const parentDirectory = path.dirname(path.resolve(databasePath));
      if (!fs.existsSync(parentDirectory)) {
        fs.mkdirSync(parentDirectory, { recursive: true });
      }
    }

    this.database = new DatabaseSync(databasePath);
    this.configurePragmas(databasePath === ':memory:');
    this.initializeSchema();
  }

  /**
   * Exposes the underlying DatabaseSync instance for repository queries.
   *
   * @returns the active DatabaseSync connection
   */
  public getConnection(): DatabaseSync {
    return this.database;
  }

  /**
   * Executes a synchronous callback inside an atomic SQLite IMMEDIATE transaction.
   *
   * @param operation the callback containing one or more SQL mutations
   * @returns the return value of operation when committed cleanly
   * @throws unknown rethrows any error thrown by operation after rolling back the transaction
   */
  public runInTransaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Closes the SQLite database handle cleanly during process shutdown.
   */
  public close(): void {
    this.database.close();
  }

  /**
   * Configures SQLite concurrency and durability pragmas.
   *
   * @param isInMemory whether the connection uses an ephemeral in-memory database
   */
  private configurePragmas(isInMemory: boolean): void {
    this.database.exec('PRAGMA busy_timeout = 5000;');
    this.database.exec('PRAGMA foreign_keys = ON;');
    if (!isInMemory) {
      this.database.exec('PRAGMA journal_mode = WAL;');
      this.database.exec('PRAGMA synchronous = NORMAL;');
    }
  }

  /**
   * Creates the students and system_settings tables and supporting indexes when absent.
   */
  private initializeSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS students (
        student_id TEXT PRIMARY KEY,
        full_name TEXT NOT NULL,
        discord_id TEXT NOT NULL UNIQUE,
        is_verified INTEGER NOT NULL DEFAULT 1,
        is_round_1 INTEGER NOT NULL DEFAULT 1,
        is_round_2 INTEGER NOT NULL DEFAULT 0,
        is_round_3 INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_students_discord_id ON students(discord_id);
      CREATE INDEX IF NOT EXISTS idx_students_rounds
        ON students(is_round_1, is_round_2, is_round_3);

      CREATE TABLE IF NOT EXISTS system_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL
      );
    `);
  }
}
