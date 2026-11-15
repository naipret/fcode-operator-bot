# System Architecture and Data Model

This document defines the package boundaries, execution concurrency model, and SQLite database schema of `fcode-operator-bot`.

---

## 1. Layered MVC Package Architecture

The runtime bot separates configuration, domain state, persistence, domain rules, and Discord presentation into distinct layers under `src/`.

| Layer         | Directory        | Responsibility                                                                                        | Prohibited Dependencies                     |
| ------------- | ---------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Configuration | `src/config`     | Parses `.env` and `config.yaml` with `Zod` and reports all missing fields at startup                  | Discord API or SQLite client calls          |
| Domain Model  | `src/model`      | Defines immutable `Student` records, stage keys, and typed action results                             | Discord API, filesystem I/O, or SQL queries |
| Repository    | `src/repository` | Manages the built-in `node:sqlite` connection and executes parameterized SQL statements               | Discord.js objects or embed formatting      |
| Controller    | `src/controller` | Enforces verification, rejoin recovery, concurrency locks, and Guild edits                            | Slash command builder syntax                |
| View          | `src/view`       | Registers Discord slash commands, modals, select menus, and renders Embeds                            | Direct SQL queries or regex business logic  |
| Utilities     | `src/util`       | Performs Title Case and PascalCase normalization, cohort checks, Snowflake ID resolution, and logging | Stateful business mutations                 |

---

## 2. Asynchronous Event Loop and Concurrency Model

Discord bots are network-bound applications. The runtime executes entirely on Node.js asynchronous non-blocking I/O without `worker_threads`, avoiding redundant V8 isolate memory overhead.

```text
Discord Interaction
       │
       ▼
Immediate deferReply (extends interaction timeout to 15 min)
       │
       ▼
Per-User In-Flight Mutex Set (blocks duplicate clicks by discord_id)
       │
       ▼
Synchronous node:sqlite Lookup (WAL mode)
       │
       ▼
Single Combined member.edit({ nick, roles }) via @discordjs/rest Queue
```

Two mechanisms prevent overload during recruitment registration peaks:

1. Calling `member.edit({ nick, roles })` bundles nickname modification and role assignment into one HTTP `PATCH` request instead of two, doubling throughput under Discord's per-guild rate limit.
2. `@discordjs/rest` maintains an internal bucketed rate-limit queue that reads `X-RateLimit-Remaining` headers and delays excess mutations cleanly without dropping interactions.

---

## 3. SQLite Database Schema

Storage relies on Node's built-in `node:sqlite` (`DatabaseSync`) configured in `WAL` journal mode with a 5000-millisecond busy timeout. The directory configured in `database.directory` (`./data` by default) is created dynamically at startup when `DatabaseClient` initializes `recruitment-<prefix>.db` (derived from `bot.clubCohortPrefix` in lowercase, such as `data/recruitment-f22.db`).

Operational logging uses `pino` configured via `logging` in `config.yaml`: pretty-printed output to stdout (`pino-pretty`) when `logging.console` is `true`, and structured JSON lines written to midnight-rotating daily files (`logs/YYYY-MM-DD.log`) under `logging.directory` when `logging.file` is `true`.

### Table `students`

| Column           | SQLite Type | Constraints          | Description                                                 |
| ---------------- | ----------- | -------------------- | ----------------------------------------------------------- |
| `student_id`     | `TEXT`      | `PRIMARY KEY`        | Uppercase student identifier such as `SE220001`             |
| `full_name`      | `TEXT`      | `NOT NULL`           | Normalized `Title Case` student name such as `Nguyễn Văn A` |
| `discord_id`     | `TEXT`      | `NOT NULL UNIQUE`    | Discord user snowflake identifier                           |
| `is_verified`    | `INTEGER`   | `NOT NULL DEFAULT 1` | Verification flag (`1` when active, `0` when inactive)      |
| `is_challenge_1` | `INTEGER`   | `NOT NULL DEFAULT 1` | Tracks whether the candidate holds the Challenge 1 role     |
| `is_challenge_2` | `INTEGER`   | `NOT NULL DEFAULT 0` | Tracks whether the candidate holds the Challenge 2 role     |
| `is_challenge_3` | `INTEGER`   | `NOT NULL DEFAULT 0` | Tracks whether the candidate holds the Challenge 3 role     |

### Table `system_settings`

| Column          | SQLite Type | Constraints   | Description                                      |
| --------------- | ----------- | ------------- | ------------------------------------------------ |
| `setting_key`   | `TEXT`      | `PRIMARY KEY` | Configuration key such as `verification_enabled` |
| `setting_value` | `TEXT`      | `NOT NULL`    | Serialized setting value (`true` or `false`)     |
