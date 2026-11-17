# F-Code Operator Discord Bot

Configuration-driven Discord recruitment bot for F-Code Club at FPT University. The bot automates single-step candidate verification (`{prefix}_{PascalCaseName}_{StudentID}`), stage role management across three recruitment rounds, instant rejoin restoration, and owner-controlled bulk stage transitions.

---

## 1. Technical Stack and Constraints

| Component       | Specification                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| Runtime         | Node.js LTS (`>= 22.15.0`)                                                                             |
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
├── .env.example
├── commitlint.config.mjs
├── config.example.yaml
├── CONTRIBUTING.md
├── Dockerfile
├── eslint.config.mjs
├── package.json
└── tsconfig.json
```

---

## 3. Local Setup and Execution

1. Copy `.env.example` to `.env` and populate `DISCORD_APPLICATION_TOKEN`, `DISCORD_APPLICATION_ID`, and `DISCORD_SERVER_ID`.
2. Copy `config.example.yaml` to `config.yaml` and populate `permissions.ownerRoleId`, `permissions.moderatorRoleId`, `permissions.verifiedRoleId`, `permissions.roundRoleIds`, and `logging.discord.channelId` (if Discord logging is enabled).
3. For prebuilt **Latest Release** archives (`fcode-operator-bot.zip` / `.tar.gz`), install runtime dependencies only and start directly without building:

```bash
npm ci --omit=dev
npm run start
```

Or for local development from source:

```bash
npm install
npm run format
npm run lint
npm run dev
```

For Docker builds and container execution, mount `.env`, `config.yaml`, and the persistent `data/` and `logs/` volumes:

```bash
docker build -t fcode-operator-bot .
docker run -d --restart unless-stopped --env-file .env -v $(pwd)/config.yaml:/app/config.yaml:ro -v $(pwd)/data:/app/data -v $(pwd)/logs:/app/logs fcode-operator-bot
```

---

## 4. Slash Commands Overview

| Command                 | Access Tier         | Behavior                                                                                                                              |
| ----------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `/verify`               | Everyone            | Verifies new candidates (`verifiedRoleId` + optional `defaultRound`) or restores returning accounts publicly in the channel           |
| `Verify Account` button | Everyone            | Opens the same one-step verification or restoration flow with ephemeral responses                                                     |
| `/student lookup`       | Owner and Moderator | Displays stored student full name, computed nickname, and round flags by `@user` or Student ID publicly in the channel                |
| `/student register`     | Owner and Moderator | Manually registers a student (`user` required; opens a Modal when `full-name` and `student-id` are omitted) publicly in the channel   |
| `/student reset`        | Owner and Moderator | Deletes a student record from SQLite and strips recruitment roles by `@user` or Student ID publicly in the channel                    |
| `/round promote`        | Owner               | Transitions students between any two stages (`verified`, `round-1..3`) with confirmation prompt and optional `exclude`/`only` filters |
| `/round revoke`         | Owner               | Bulk removes a round role with confirmation prompt and optional `exclude`/`only` filters publicly in the channel                      |
| `/system verify`        | Owner               | Enables or disables verification and optionally posts/updates the verification button panel in a selected text channel                |
| `/system sync`          | Owner               | Reconciles SQLite student records (nicknames and roles) to Discord publicly in the channel                                            |
| `/system reload`        | Owner               | Validates and hot-reloads `config.yaml`, `Logger`, and `sync`/`backup` timers with zero downtime                                      |

---

## 5. Documentation Index

1. [Server Permissions Specification](docs/SERVER_PERMISSIONS.md): Role hierarchy, categories, channels, and permission overwrites.
2. [Architecture and Data Model](docs/ARCHITECTURE_MODEL.md): Layered MVC boundaries, event-loop concurrency, and SQLite schema.
3. [Design Principles](docs/DESIGN_PRINCIPLES.md): `SOLID`, `SoC`, `DRY`, `KISS`, and `YAGNI` applications.
4. [Design Patterns](docs/DESIGN_PATTERNS.md): Repository, Factory, Singleton, Guard Mutex, and Observer patterns.
5. [Naming Conventions](docs/NAMING_CONVENTIONS.md): TypeScript and Discord naming standards.
6. [Clean Code Standards](docs/CLEAN_CODE.md): TSDoc-only comment rules and exception handling discipline.
7. [Engineering Writing Style](docs/WRITING_STYLE.md): Technical prose rules enforced across all project documentation.

---

## 6. License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
