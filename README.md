# F-Code Operator Bot

Configuration-driven Discord recruitment bot for F-Code Club at FPT University. The bot automates single-step candidate verification, stage role management across three recruitment rounds, instant rejoin restoration, and owner-controlled bulk stage transitions.

---

## 1. Technical Stack and Constraints

| Component       | Specification                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| Runtime         | Node.js (`>= 24.0.0`)                                                                                  |
| Language        | TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`)                                          |
| Discord SDK     | `discord.js` v14 with Gateway `Guilds` and `GuildMembers` intents                                      |
| Persistence     | Built-in `node:sqlite` (`DatabaseSync` in `WAL` mode, stored at `data/recruitment-<prefix>.db`)        |
| Logging         | 3-tier `pino` (`file` with `maxFiles` pruning, `pino-pretty` `console`, and batched `discord` channel) |
| Validation      | `Zod` for `config.yaml` and environment variables with itemized startup error reporting                |
| Quality Tooling | ESLint with TypeScript type checking, Prettier, Husky Git hooks, Commitlint, and GitHub Actions CI     |

---

## 2. Project Structure

```text
fcode-operator-bot/
├── .github/
├── .husky/
├── docs/
├── src/
│   ├── index.ts
│   ├── client.ts
│   ├── config/
│   ├── model/
│   ├── repository/
│   ├── controller/
│   ├── view/
│   └── util/
├── .editorconfig
├── .env.example
├── .prettierrc
├── AGENTS.md
├── commitlint.config.mjs
├── config.example.yaml
├── CONTRIBUTING.md
├── Dockerfile
├── eslint.config.mjs
├── LICENSE
├── package.json
├── README.md
└── tsconfig.json
```

---

## 3. Setup and Deployment

### Prerequisites

1. Create or reference the F22 recruitment server layout using the [Discord Server Template](https://discord.new/K7yMwH3Rx7B4) and adjust roles, channels, and permissions to match your recruitment cycle.
2. Enable the Server Members Intent under Privileged Gateway Intents in the Discord Developer Portal, and invite the bot with the `bot` and `applications.commands` scopes.
3. Position the bot's managed role above `moderator`, `supporter`, `verified`, and `round-1` through `round-3` so the bot can update candidate and staff nicknames and assign roles.
4. Copy `.env.example` to `.env` and populate `DISCORD_APPLICATION_TOKEN`, `DISCORD_APPLICATION_ID`, and `DISCORD_SERVER_ID`.
5. Copy `config.example.yaml` to `config.yaml` and populate `permissions.ownerRoleId`, `permissions.moderatorRoleId`, `permissions.supporterRoleId`, `permissions.verifiedRoleId`, and `permissions.roundRoleIds`. Populate `logging.discord.channelId` if `logging.discord.enabled` is `true`.

### Option A: Prebuilt Release Archive

Use this deployment path on free Discord bot hosting panels or low-memory VPS instances to run prebuilt JavaScript without installing TypeScript or compiling on the host.

1. Download `fcode-operator-bot.zip` or `fcode-operator-bot.tar.gz` from the Latest Release on GitHub Releases and extract the archive into the host working directory.
2. Place your configured `.env` and `config.yaml` files alongside `package.json`.
3. Install production dependencies only and start the prebuilt bundle:

```bash
npm ci --omit=dev --ignore-scripts
npm run start
```

If a hosting panel invokes Node directly instead of `npm run start`, set the startup command to `node --env-file-if-exists=.env dist/index.js`.

### Option B: From Source

Use this option when developing locally or building from the TypeScript source (`src/`):

```bash
npm ci
npm run format:check
npm run lint
npm run build
npm run start
```

For hot-reloading development with `tsx`:

```bash
npm run dev
```

### Option C: Docker

Mount `.env`, `config.yaml`, and persistent `data/` and `logs/` directories so SQLite databases, backups, and daily log files survive container restarts:

```bash
docker build -t fcode-operator-bot .
docker run -d --restart unless-stopped --env-file .env -v $(pwd)/config.yaml:/app/config.yaml:ro -v $(pwd)/data:/app/data -v $(pwd)/logs:/app/logs fcode-operator-bot
```

---

## 4. Slash Commands Overview

| Command                 | Access Tier         | Behavior                                                                                                                             |
| ----------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/verify`               | Everyone            | Verifies new candidates (`verifiedRoleId` + optional `defaultRound`) or restores returning accounts publicly in the channel          |
| `Verify Account` button | Everyone            | Opens the same one-step verification or restoration flow with ephemeral responses                                                    |
| `/student lookup`       | Owner and Moderator | Displays stored candidate full name, computed nickname, and round flags by `@user` or Student ID publicly in the channel             |
| `/student register`     | Owner and Moderator | Manually registers a candidate student (`user` required; opens a Modal when `full-name` and `student-id` are omitted)                |
| `/student update`       | Owner and Moderator | Updates independent `round-1` through `round-3` flags and optional name or Student ID for candidates by `@user` or Student ID        |
| `/student reset`        | Owner and Moderator | Deletes a candidate student record from SQLite and strips recruitment roles by `@user` or Student ID                                 |
| `/round promote`        | Owner               | Transitions candidates between stages (`verified`, `round-1..3`), preserving higher round flags when promoting upward                |
| `/round revoke`         | Owner               | Bulk removes one or more selected round roles with confirmation prompt and optional `exclude`/`only` filters publicly in the channel |
| `/system verify`        | Owner               | Enables or disables verification and optionally posts a new verification button panel in a selected text channel                     |
| `/system sync`          | Owner               | Reconciles SQLite student and staff records (nicknames and roles) to Discord publicly in the channel                                 |
| `/system staff`         | Owner               | Promotes verified members to `moderator` or `supporter` (`MOD` or `SUP` prefix) or clears all roles and DB record (`reset`)          |
| `/system reload`        | Owner               | Validates and hot-reloads `config.yaml`, `Logger`, and the `backup` timer with zero downtime                                         |

---

## 5. Documentation Index

1. [Server Permissions Specification](docs/SERVER_PERMISSIONS.md): Role hierarchy, categories, channels, and permission overwrites.
2. [Architecture and Data Model](docs/ARCHITECTURE_MODEL.md): Layered MVC boundaries, event-loop concurrency, and SQLite schema.
3. [Design Principles](docs/DESIGN_PRINCIPLES.md): `SOLID`, `SoC`, `DRY`, `KISS`, and `YAGNI` applications.
4. [Design Patterns](docs/DESIGN_PATTERNS.md): Repository, Factory, Validated Config, Guard Mutex, and Observer patterns.
5. [Naming Conventions](docs/NAMING_CONVENTIONS.md): TypeScript and Discord naming standards.
6. [Clean Code Standards](docs/CLEAN_CODE.md): TSDoc-only comment rules and exception handling discipline.
7. [Engineering Writing Style](docs/WRITING_STYLE.md): Technical prose rules enforced across all project documentation.
8. [Contributing Guidelines](CONTRIBUTING.md): Git workflow, Conventional Commits, and automated Husky quality checks.
9. [AI Agent Guide](AGENTS.md): Operating boundaries, verification commands, and reference index for AI coding agents.

---

## 6. License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
