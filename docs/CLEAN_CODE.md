# Clean Code and Documentation Standards

This document defines comment discipline, TSDoc formatting, exception handling, and startup validation across `fcode-operator-bot`.

---

## 1. Comment Policy and TSDoc Requirements

### Zero Single-Line or Inline Block Comments

Single-line comments (`// ...`) and inline block comments (`/* ... */`) are strictly prohibited anywhere inside `.ts` files in `src/`. Every block of logic must be self-explanatory through clear naming and helper extraction.

### Plain-Text TSDoc Only

Every module, class, interface, type alias, exported constant, constructor, method, and standalone function must include a standard TSDoc block (`/** ... */`) written in clear English prose (`en-US`):

1. Omit HTML tags (`<p>`, `<ul>`, `<li>`, `<b>`, `<br>`) inside TSDoc blocks.
2. Document all parameters with `@param`, return values with `@returns`, and thrown errors with `@throws`.

```typescript
/**
 * Builds and validates a standardized recruitment nickname from raw user input.
 *
 * @param rawFullName the raw full name submitted by the student
 * @param rawStudentId the raw student identifier submitted by the student
 * @param botConfig the bot naming configuration from config.yaml
 * @returns a validation result containing Title Case name, PascalCase nickname, or an error reason
 */
function buildValidatedNickname(
  rawFullName: string,
  rawStudentId: string,
  botConfig: BotConfig,
): NicknameValidationResult {
```

---

## 2. Control Flow and Method Decomposition

1. Keep methods focused on a single task at one abstraction level, targeting under 40 lines per method.
2. Limit control-flow nesting to at most three levels by placing guard clauses and early returns at the top of each method.
3. Extract repeated Discord permission checks, embed rendering, and input parsing into dedicated helper methods or utilities instead of duplicating logic across command handlers.

---

## 3. Error Handling and Startup Validation

1. Validate `.env` and `config.yaml` with `Zod` at startup so any empty or malformed configuration keys are itemized together in a single fatal report before connecting to Discord.
2. Verify on `ClientReady` that every configured Discord Snowflake ID (`supportChannelId`, `ownerRoleId`, `moderatorRoleId`, and `stageRoleIds`) exists in the target guild cache.
3. Catch expected Discord API exceptions such as `50013` (Missing Permissions when mutating the Server Owner or higher-ranked roles) and translate them into clear user-facing guidance rather than unhandled promise rejections.
4. Wrap database mutations that update multiple records inside explicit SQLite transactions (`runInTransaction`) so partial state updates cannot occur on unexpected errors.
5. Register `SIGINT` and `SIGTERM` shutdown handlers to close the Discord client and SQLite connection cleanly on process exit.
