# Software Design Principles Specification

This document describes how object-oriented design, `SOLID` principles, and foundational engineering constraints (`SoC`, `DRY`, `KISS`, `YAGNI`) govern `fcode-operator-bot`.

---

## 1. SOLID Principles

### Single Responsibility Principle

Each class and module owns one cohesive responsibility:

1. `ConfigLoader` reads YAML files and validates environment schemas without holding Discord client references.
2. `InputValidator` performs stateless Title Case and PascalCase normalization, cohort extraction, template interpolation, and length verification.
3. `StudentRepository` handles SQLite reads and writes without knowing Discord API error codes.
4. `VerificationController`, `StudentController`, and `RoundController` enforce domain logic without rendering Embed UI components.
5. `EmbedFactory` and `*CommandView` classes construct Discord UI payloads without executing SQL queries.

### Open and Closed Principle

Recruitment parameters, cohort ranges (`allowedCohorts`), cohort prefixes (`clubCohortPrefix`), support channel ID (`supportChannelId`), and permission role IDs (`ownerRoleId`, `moderatorRoleId`, `roundRoleIds`) reside in `config.yaml`. Transitioning to a new cohort prefix or deploying on a new server template requires editing `config.yaml` rather than modifying controller source code.

### Interface Segregation Principle

Controller constructors receive only the narrow collaborators they require. `VerifyCommandView` depends on `VerificationController`, `StudentRepository`, and `GuildResourceResolver`, while `RoundCommandView` depends on `RoundController` and `GuildResourceResolver`.

### Dependency Inversion Principle

High-level composition occurs exclusively in `src/index.ts`, which constructs `DatabaseClient`, `StudentRepository`, controllers, and command views once and injects them through explicit constructor parameters.

---

## 2. Core Engineering Principles

### Separation of Concerns

Production bot runtime under `src/` is strictly decoupled from local server provisioning or setup utilities. The runtime bot executes recruitment verification and stage management exclusively.

### Don't Repeat Yourself

Shared operations are centralized in utility helpers:

1. Discord authorization checks (`isOwnerOrHasOwnerRole`, `isModeratorOrOwner`) and Snowflake ID resolution (`getStageRole`, `getSupportChannelMention`) reside in `GuildResourceResolver`.
2. Target parsing for mixed `@mention` and student identifier strings resides in `InputValidator.parseTargetTokens`.
3. Success, warning, and error embeds use `EmbedFactory` to guarantee uniform visual output across all commands.

### Keep It Simple, Stupid

1. Verification operates in a single step requesting only `Full Name` and `Student ID`, avoiding multi-step stateful wizards.
2. Rejoin detection queries `students` by `discord_id` inside the `/verify` or button interaction handler instead of maintaining a continuous `guildMemberAdd` event pipeline.
3. Database access uses Node's built-in `node:sqlite` driver rather than native C++ addons or external cloud database proxies.

### You Aren't Gonna Need It

Unneeded features including pre-registered whitelist mode, student major collection, CSV export and import utilities, and redundant team-assignment slash commands are omitted to keep the production surface minimal.
