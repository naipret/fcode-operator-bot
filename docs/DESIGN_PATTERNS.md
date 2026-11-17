# Software Design Patterns Specification

This document identifies the recurring structural and behavioral patterns implemented across `fcode-operator-bot`.

---

## 1. Repository Pattern (`DatabaseClient` and `StudentRepository`)

`StudentRepository` encapsulates every parameterized `StatementSync` query against `node:sqlite`, exposing typed domain methods (`findByStudentId`, `findByDiscordId`, `upsertStudent`, `syncRoleStateByDiscordId`) to controllers. Controllers interact solely with `Student` objects and never compose SQL strings directly.

---

## 2. Factory Pattern (`EmbedFactory`)

`EmbedFactory` centralizes the creation of Discord `EmbedBuilder` instances for uniform status semantics (`buildSuccessEmbed`, `buildWarningEmbed`, `buildErrorEmbed`, `buildInfoEmbed`, `buildBatchMutationEmbed`). All command views produce consistent colors, timestamps, and English phrasing by delegating message styling to `EmbedFactory`.

---

## 3. Validated Configuration Loader (`ConfigLoader`)

`ConfigLoader` parses `.env` and `config.yaml` at startup and during `/system reload`, validates all required fields, regular expressions, and Snowflake IDs with `Zod`, reports any missing entries in one itemized error, and supplies the validated `AppConfig` instance via Dependency Injection.

---

## 4. Guard and Mutex Pattern (`MemberMutationHelper`)

Every verification and member mutation entry point validates gate status, full name and student ID boundaries, and per-user lock state via early-return guard clauses before touching SQLite or Discord APIs. A shared in-memory `Set<string>` keyed by `discord_id` is passed to `VerificationController`, `StudentController`, and `RoundController`, preventing concurrent execution races inside `try ... finally` blocks.

---

## 5. Observer Synchronization (`guildMemberUpdate`)

The bot registers a lightweight event observer on `Events.GuildMemberUpdate` in `src/index.ts`. Whenever staff members or external bots add or remove configured round roles on Discord while the member is not locked by an active bot mutation, `VerificationController.syncMemberRolesToDatabase` reconciles `is_round_1`, `is_round_2`, and `is_round_3` back into the local SQLite database while preserving `is_verified` (which is cleared only by `/student reset` or staff promotion). When `moderator` or `supporter` staff roles are added or switched on a verified member, the observer updates `is_moderator` and `is_supporter` in SQLite, sets `is_verified = 0` and `is_round_1..3 = 0`, strips candidate roles, and rewrites the nickname prefix to `moderatorPrefix` or `supporterPrefix` (`MOD` takes precedence over `SUP`). When all staff roles are removed, the observer strips candidate roles, deletes the SQLite record, and clears the nickname so the user must re-verify. Conversely, `StudentController.syncStudentsToDiscord` reconciles SQLite candidate and staff records back to Discord on startup and via `/system sync`.

---

## 6. Independent Round Flags and Non-Destructive Promotion (`RoundController`)

Round flags (`is_round_1`, `is_round_2`, `is_round_3`) are stored independently rather than as a single scalar stage. This design lets organizers run `/round revoke` on a single round (for example, re-running `round-2` without touching `round-3`) or toggle individual flags via `/student update`. When `/round promote` moves upward (`to` is higher than `from`, such as `verified` to `round-2` or `round-1` to `round-2`), `RoundController` enables the target stage flags and adds the corresponding roles while preserving any higher round flags and roles already held by each candidate. Explicit downward transitions (`to` is lower than `from`, such as `round-3` to `round-2` or `to: verified`) overwrite the candidate flags and round roles to match the target stage.
