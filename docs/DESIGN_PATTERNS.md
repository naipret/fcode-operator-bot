# Software Design Patterns Specification

This document identifies the recurring structural and behavioral patterns implemented across `fcode-operator-bot`.

---

## 1. Repository Pattern (`DatabaseClient` and `StudentRepository`)

`StudentRepository` encapsulates every parameterized `StatementSync` query against `node:sqlite`, exposing typed domain methods (`findByStudentId`, `findByDiscordId`, `upsertStudent`, `syncRoleStateByDiscordId`) to controllers. Controllers interact solely with `Student` objects and never compose SQL strings directly.

---

## 2. Factory Pattern (`EmbedFactory`)

`EmbedFactory` centralizes the creation of Discord `EmbedBuilder` instances for uniform status semantics (`buildSuccessEmbed`, `buildWarningEmbed`, `buildErrorEmbed`, `buildInfoEmbed`, `buildBatchMutationEmbed`). All command views produce consistent colors, timestamps, and English phrasing by delegating message styling to `EmbedFactory`.

---

## 3. Singleton Configuration Loader (`ConfigLoader`)

`ConfigLoader` parses `.env` and `config.yaml` once at startup, validates all required fields and Snowflake IDs with `Zod`, reports any missing entries in one itemized error, and serves the validated `AppConfig` instance across the application lifecycle.

---

## 4. Guard and Mutex Pattern (`VerificationController`)

Every verification entry point validates gate status, full name and student ID boundaries, and per-user lock state via early-return guard clauses before touching SQLite or Discord APIs. An in-memory `Set<string>` acts as a deterministic lock keyed by `discord_id`, preventing concurrent execution races inside `try ... finally` blocks.

---

## 5. Observer Synchronization (`guildMemberUpdate`)

The bot registers a lightweight event observer on `Events.GuildMemberUpdate` in `src/index.ts`. Whenever staff members add or remove configured round roles manually on Discord, `VerificationController.syncMemberRolesToDatabase` reconciles `is_round_1`, `is_round_2`, and `is_round_3` back into the local SQLite database. Conversely, `StudentController.syncStudentsToDiscord` reconciles manual SQLite edits back to Discord on startup and via `/student sync`.
