# F-Code Operator Discord Bot

Configuration-driven Discord recruitment bot for F-Code Club at FPT University. The bot automates single-step candidate verification (`{prefix}_{PascalCaseName}_{StudentID}`), stage role management across three recruitment rounds, instant rejoin restoration, and owner-controlled bulk stage transitions.

---

## 1. Technical Stack and Constraints

| Component       | Specification                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------- |
| Runtime         | Node.js LTS (`>= 22.15.0`)                                                                         |
| Language        | TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`)                                      |
| Discord SDK     | `discord.js` v14 with Gateway `Guilds` and `GuildMembers` intents                                  |
| Persistence     | Built-in `node:sqlite` (`DatabaseSync` in `WAL` mode, stored at `data/operator.db`)                |
| Validation      | `Zod` for `config.yaml` and environment variables with itemized startup error reporting            |
| Quality Tooling | ESLint with TypeScript type checking, Prettier, Husky Git hooks, Commitlint, and GitHub Actions CI |

---

## 2. Project Structure

```text
fcode-operator-bot/
├── .github/
├── .husky/
├── docs/
│   ├── ARCHITECTURE_MODEL.md
│   ├── CLEAN_CODE.md
│   ├── DESIGN_PATTERNS.md
│   ├── DESIGN_PRINCIPLES.md
│   ├── NAMING_CONVENTIONS.md
│   ├── SERVER_PERMISSIONS.md
│   └── WRITING_STYLE.md
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
2. Copy `config.example.yaml` to `config.yaml` and populate `verification.supportChannelId`, `permissions.ownerRoleId`, `permissions.moderatorRoleId`, and `permissions.stageRoleIds`.
3. Install dependencies and start the bot:

```bash
npm install
npm run format
npm run lint
npm run dev
```

For Docker builds and container execution, mount `.env`, `config.yaml`, and the persistent `data/` volume:

```bash
docker build -t fcode-operator-bot .
docker run -d --restart unless-stopped --env-file .env -v $(pwd)/config.yaml:/app/config.yaml:ro -v $(pwd)/data:/app/data fcode-operator-bot
```

---

## 4. Slash Commands Overview

| Command                   | Access Tier                     | Behavior                                                                                                      |
| ------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `/verify`                 | Everyone                        | Verifies new candidates in one step or restores returning verified accounts, replying publicly in the channel |
| `Verify Account` button   | Everyone                        | Opens the same one-step verification or restoration flow with ephemeral responses                             |
| `/student lookup`         | Server Owner and moderator role | Displays stored student full name, computed nickname, challenge flags, and team name                          |
| `/student register`       | Server Owner and moderator role | Manually registers or overrides a student record and Discord roles for support resolution                     |
| `/student reset`          | Server Owner and moderator role | Deletes a student record from SQLite and strips recruitment roles                                             |
| `/challenge advance`      | Server Owner and owner role     | Bulk promotes candidates between stages with optional `exclude` or `only` user filters                        |
| `/challenge revoke`       | Server Owner and owner role     | Bulk removes a stage role from selected users via inline mentions, IDs, or multi-user select menu             |
| `/challenge verify`       | Server Owner and owner role     | Enables or disables new `/verify` registrations dynamically                                                   |
| `/challenge verify-panel` | Server Owner and owner role     | Posts or updates the persistent verification button embed in any selected text channel                        |

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
