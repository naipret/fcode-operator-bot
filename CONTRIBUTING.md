# Contributing Guidelines

This document defines version control practices, commit message standards, and pre-commit verification for `fcode-operator-bot`.

---

## 1. Git Workflow on `main`

Development takes place directly on the `main` branch through small, atomic commits. Each commit encapsulates one cohesive module, feature, or documentation update so changes remain easy to inspect and revert.

---

## 2. Commit Message Standards

All commit messages must adhere to the Conventional Commits specification enforced automatically at the Git hook layer by Commitlint (`commitlint.config.mjs`) and Husky (`.husky/commit-msg`):

```text
<type>[optional scope][!]: <description>

[optional body]

[optional footer(s)]
```

### Allowed Commit Types

| Type       | Usage                                                     |
| ---------- | --------------------------------------------------------- |
| `feat`     | Adds a user-facing feature, configuration key, or command |
| `fix`      | Resolves a runtime bug or permission mismatch             |
| `docs`     | Updates documentation or TSDoc comments                   |
| `style`    | Applies Prettier formatting or whitespace adjustments     |
| `refactor` | Restructures code without altering external behavior      |
| `perf`     | Improves execution throughput or memory profile           |
| `build`    | Updates build pipeline, Dockerfile, or dependencies       |
| `ci`       | Modifies GitHub Actions workflows or issue templates      |
| `chore`    | Performs repository or tooling maintenance                |

---

## 3. Automated Git Hooks and Quality Checks

Husky binds `.husky/pre-commit` and `.husky/commit-msg` directly to Git so every `git commit` executes the following checks automatically:

1. `npm run format:check` verifies that all staged and workspace files match `.prettierrc`. Run `npm run format` to apply formatting fixes before committing.
2. `npm run lint` runs ESLint with `typescript-eslint` type checking enabled (`projectService: true`), catching both lint violations and TypeScript compiler errors.
3. `commitlint` validates the commit message header against Conventional Commits rules.

Before pushing or building a release image, run `npm run build` to verify clean emission into `dist/`. Confirm zero single-line `//` comments or inline `/* ... */` comments exist in any `.ts` file, and keep `.env`, `config.yaml`, and `data/` untracked.
