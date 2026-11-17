# Naming Conventions Specification

This specification defines identifier casing, architectural suffixes, method prefixes, and Discord naming standards enforced across `fcode-operator-bot`.

---

## 1. TypeScript Identifier Rules

| Element Type           | Case Convention    | Grammatical Form                               | Project Examples                                               |
| ---------------------- | ------------------ | ---------------------------------------------- | -------------------------------------------------------------- |
| Directory              | `lowercase`        | Single domain layer noun                       | `config`, `model`, `repository`, `controller`, `view`, `util`  |
| File                   | `PascalCase`       | Matches primary exported class or module       | `VerificationController.ts`, `InputValidator.ts`               |
| Class and Interface    | `PascalCase`       | Singular noun phrase with architectural suffix | `StudentRepository`, `VerificationController`, `EmbedFactory`  |
| Method and Function    | `camelCase`        | Imperative verb phrase                         | `toTitleCaseFullName`, `toPascalCaseAsciiName`, `getStageRole` |
| Variable and Parameter | `camelCase`        | Descriptive noun phrase without abbreviations  | `studentId`, `formattedFullName`, `targetRoleIds`              |
| Constant               | `UPPER_SNAKE_CASE` | Uppercase words separated by underscores       | `DISCORD_MISSING_PERMISSIONS_CODE`, `VERIFY_PANEL_BUTTON_ID`   |

Single-letter variable names and informal abbreviations such as `rnd`, `btc`, `mod`, `tmp`, or `res` are prohibited in TypeScript identifiers and documentation.

---

## 2. Architectural Suffixes by Layer

| Directory    | Required Suffix                      | Responsibility                                                  | Examples                                                                     |
| ------------ | ------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `config`     | `*Schema`, `*Loader`                 | Declares Zod configuration schemas and loads YAML configuration | `ConfigSchema`, `ConfigLoader`                                               |
| `model`      | Domain noun                          | Represents domain entities, records, and result structures      | `Student`, `VerificationOutcome`                                             |
| `repository` | `*Client`, `*Repository`             | Manages SQLite connections and executes data queries            | `DatabaseClient`, `StudentRepository`                                        |
| `controller` | `*Controller`                        | Enforces domain logic and orchestrates state changes            | `VerificationController`, `StudentController`, `RoundController`             |
| `view`       | `*Factory`, `*CommandView`           | Registers slash commands and renders Discord responses          | `EmbedFactory`, `VerifyCommandView`, `RoundCommandView`, `SystemCommandView` |
| `util`       | `*Validator`, `*Resolver`, `*Logger` | Provides stateless validation, Snowflake ID lookup, and logging | `InputValidator`, `GuildResourceResolver`, `Logger`                          |

---

## 3. Method Verb and Predicate Prefixes

| Prefix                | Contract and Return Type                                     | Examples                                                               |
| --------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `is*`, `has*`, `can*` | Side-effect-free predicate returning `boolean`               | `isOwnerOrHasOwnerRole`, `isModeratorOrOwner`, `isVerificationEnabled` |
| `find*`               | Single-record lookup returning an entity or `null`           | `findByStudentId`, `findByDiscordId`                                   |
| `list*`               | Multi-record query returning an array                        | `listByRound`, `listAllVerifiedStudents`                               |
| `build*`              | Pure construction returning a formatted value object         | `buildValidatedNickname`, `buildSuccessEmbed`                          |
| `validate*`           | Invariant verification returning a typed validation result   | `validateStudentId`, `validateFullName`, `validateConfiguredResources` |
| `to*`                 | Pure transformation returning canonical casing or ASCII form | `toTitleCaseFullName`, `toPascalCaseAsciiName`                         |
| `sync*`, `restore*`   | State reconciliation against Discord or SQLite               | `syncMemberRolesToDatabase`, `restoreExistingStudent`                  |

---

## 4. Discord Naming Standards

| Discord Resource                    | Format Rule                                    | Language                      | Examples                                                         |
| ----------------------------------- | ---------------------------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| System, Staff, Bot, and Round Roles | Configurable via Snowflake ID in `config.yaml` | English (`en-US`)             | `owner`, `moderator`, `round-1`, `round-2`, `round-3`            |
| Categories                          | `UPPERCASE`                                    | English (`en-US`), full words | `GATEWAY`, `ROUND 1`, `STAFF`                                    |
| Channels                            | Unicode 6.0 emoji plus `・` plus `kebab-case`  | English (`en-US`), full words | `✅・verification`, `🎫・support-ticket`, `💬・staff-discussion` |
| Slash Command Options               | Strict `kebab-case`                            | English (`en-US`), full words | `full-name`, `student-id`, `channel`                             |
