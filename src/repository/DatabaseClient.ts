import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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
    if (databasePath !== ":memory:") {
      const parentDirectory = path.dirname(path.resolve(databasePath));
      if (!fs.existsSync(parentDirectory)) {
        fs.mkdirSync(parentDirectory, { recursive: true });
      }
    }

    this.database = new DatabaseSync(databasePath);
    this.configurePragmas(databasePath === ":memory:");
    this.initializeSchema();
    this.runSchemaMigrations();
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
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
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
   * Creates an atomic, defragmented online SQLite backup via VACUUM INTO and prunes excess files.
   *
   * @param backupDirectory destination directory for backup .db files
   * @param maxFiles maximum number of backup files to retain
   * @param cohortPrefix club cohort prefix used in backup file naming
   * @returns full path to the newly created backup file
   */
  public createBackup(
    backupDirectory: string,
    maxFiles: number,
    cohortPrefix: string,
  ): string {
    const resolvedDir = path.resolve(backupDirectory);
    if (!fs.existsSync(resolvedDir)) {
      fs.mkdirSync(resolvedDir, { recursive: true });
    }

    const now = new Date();
    const pad = (value: number, length = 2): string =>
      String(value).padStart(length, "0");
    const timestamp = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
    const filePrefix = `recruitment-${cohortPrefix.toLowerCase()}-`;
    const backupPath = this.resolveUniqueBackupPath(
      resolvedDir,
      filePrefix,
      timestamp,
    );
    const escapedPath = backupPath.replaceAll("'", "''");

    this.database.exec(`VACUUM INTO '${escapedPath}';`);

    const backups = fs
      .readdirSync(resolvedDir)
      .filter((name) => name.startsWith(filePrefix) && name.endsWith(".db"))
      .sort();

    while (backups.length > maxFiles) {
      const oldest = backups.shift();
      if (oldest) {
        fs.unlinkSync(path.join(resolvedDir, oldest));
      }
    }

    return backupPath;
  }

  /**
   * Configures SQLite concurrency and durability pragmas.
   *
   * @param isInMemory whether the connection uses an ephemeral in-memory database
   */
  private configurePragmas(isInMemory: boolean): void {
    this.database.exec("PRAGMA busy_timeout = 5000;");
    this.database.exec("PRAGMA foreign_keys = ON;");
    if (!isInMemory) {
      this.database.exec("PRAGMA journal_mode = WAL;");
      this.database.exec("PRAGMA synchronous = NORMAL;");
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
        is_round_3 INTEGER NOT NULL DEFAULT 0,
        is_moderator INTEGER NOT NULL DEFAULT 0,
        is_supporter INTEGER NOT NULL DEFAULT 0
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

  /**
   * Resolves a unique backup file path so concurrent backups in the same millisecond never collide.
   *
   * @param directory target backup directory
   * @param filePrefix cohort-scoped filename prefix
   * @param timestamp millisecond-precision timestamp string
   * @returns non-existent destination file path
   */
  private resolveUniqueBackupPath(
    directory: string,
    filePrefix: string,
    timestamp: string,
  ): string {
    const baseCandidate = path.join(directory, `${filePrefix}${timestamp}.db`);
    if (!fs.existsSync(baseCandidate)) {
      return baseCandidate;
    }

    let suffix = 1;
    let candidate = path.join(
      directory,
      `${filePrefix}${timestamp}-${String(suffix)}.db`,
    );
    while (fs.existsSync(candidate)) {
      suffix += 1;
      candidate = path.join(
        directory,
        `${filePrefix}${timestamp}-${String(suffix)}.db`,
      );
    }
    return candidate;
  }

  /**
   * Applies forward-only SQLite schema migrations tracked via PRAGMA user_version.
   */
  private runSchemaMigrations(): void {
    const versionRow = this.database.prepare("PRAGMA user_version").get() as
      { user_version: number } | undefined;
    const currentVersion = versionRow?.user_version ?? 0;

    if (currentVersion >= 2) {
      return;
    }

    const columns = this.database
      .prepare("PRAGMA table_info(students)")
      .all() as unknown as { name: string }[];
    const columnNames = new Set(columns.map((column) => column.name));

    this.runInTransaction(() => {
      if (!columnNames.has("is_moderator")) {
        this.database.exec(
          "ALTER TABLE students ADD COLUMN is_moderator INTEGER NOT NULL DEFAULT 0;",
        );
      }
      if (!columnNames.has("is_supporter")) {
        this.database.exec(
          "ALTER TABLE students ADD COLUMN is_supporter INTEGER NOT NULL DEFAULT 0;",
        );
      }
      this.database.exec("PRAGMA user_version = 2;");
    });
  }
}
