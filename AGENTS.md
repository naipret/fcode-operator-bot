# AGENTS.md

Repository guide for AI coding agents working on `fcode-operator-bot`.

## Overview

TypeScript (`strict`, `NodeNext` ESM) Discord bot on Node.js (`>= 24`) using `discord.js`, built-in `node:sqlite`, `Zod`, and `Pino`. Source code lives in `src/`, and architectural specifications live in `docs/`.

## Commands

Inspect `package.json` for all scripts. Run these quality gates after your final edit and confirm zero errors before reporting completion:

```bash
npm run format:check
npm run lint
npm run build
```

Run `npm run format` to fix Prettier formatting issues.

## Boundaries

### Always

1. Read target source files, `package.json`, and the relevant files in `docs/` before designing or editing.
2. Cite only file paths, symbol names, behaviors, and command outputs directly observed in the current session.
3. Keep changes strictly scoped to the requested task and complete all edge cases, error handling, and doc updates without shortcuts.
4. Preserve the MVC layer boundaries defined in `docs/ARCHITECTURE_MODEL.md` and the zero-comment rule in `docs/CLEAN_CODE.md`.
5. Commit incrementally as each cohesive unit is completed on `main` using Conventional Commits (`CONTRIBUTING.md`), keeping formatting, linting, and build checks green on every commit.

### Ask First

1. Clarify ambiguous requirements, business rules, or edge cases with the user before inventing behavior.
2. Confirm with the user before adding new dependencies to `package.json` or altering persistent SQLite schemas.

### Never

1. Never guess or fabricate file contents, symbol names, or verification results.
2. Never place single-line (`//`) or inline block (`/* ... */`) comments inside `src/**/*.ts`.
3. Never accumulate unrelated or multiple changes into a single commit, and never bypass `.husky/` quality hooks.
4. Never commit `.env`, `config.yaml`, `data/`, or `logs/`.

## Reference Index

Read the authoritative file on demand before working in that area:

| Area                         | Reference                    |
| ---------------------------- | ---------------------------- |
| Scripts and runtime engines  | `package.json`               |
| Git workflow and commits     | `CONTRIBUTING.md`            |
| Layered MVC and SQLite model | `docs/ARCHITECTURE_MODEL.md` |
| Comment and TSDoc rules      | `docs/CLEAN_CODE.md`         |
| Naming standards             | `docs/NAMING_CONVENTIONS.md` |
| Design principles            | `docs/DESIGN_PRINCIPLES.md`  |
| Design patterns              | `docs/DESIGN_PATTERNS.md`    |
| Roles and permissions matrix | `docs/SERVER_PERMISSIONS.md` |
| Prose and markdown style     | `docs/WRITING_STYLE.md`      |
