import type { BotConfig } from "../config/ConfigSchema.js";

/**
 * Result returned when validating a student full name and student identifier together.
 */
export type NicknameValidationResult =
  | {
      valid: true;
      studentId: string;
      formattedFullName: string;
      pascalName: string;
      nickname: string;
      cohort: string;
    }
  | {
      valid: false;
      reason: "INVALID_INPUT" | "NICKNAME_TOO_LONG";
      error: string;
      pascalName?: string;
      currentNameLength?: number;
      maxAllowedNameLength?: number;
    };

/**
 * Result returned when validating a raw student identifier string.
 */
export type StudentIdValidationResult =
  | { valid: true; studentId: string; cohort: string }
  | { valid: false; error: string };

/**
 * Result returned when validating a raw full name string.
 */
export type FullNameValidationResult =
  | { valid: true; formattedFullName: string; pascalName: string }
  | { valid: false; error: string };

/**
 * Parsed target tokens extracted from inline command filter strings.
 */
export interface ParsedTargetTokens {
  discordIds: string[];
  studentIds: string[];
}

/**
 * Strips Vietnamese diacritics and maps D-stroke characters to plain ASCII letters.
 *
 * @param value the raw string containing Vietnamese Unicode characters
 * @returns the ASCII string with all combining diacritical marks removed
 */
function stripVietnameseDiacritics(value: string): string {
  return value
    .replaceAll("Đ", "D")
    .replaceAll("đ", "d")
    .normalize("NFD")
    .replaceAll(/\p{Mn}/gu, "");
}

/**
 * Normalizes a full name into Title Case while preserving Vietnamese diacritics.
 *
 * @param rawFullName the raw full name input
 * @returns the normalized Title Case full name separated by single spaces
 */
function toTitleCaseFullName(rawFullName: string): string {
  const collapsed = rawFullName.normalize("NFC").trim().replaceAll(/\s+/g, " ");
  if (collapsed.length === 0) {
    return "";
  }

  return collapsed
    .split(" ")
    .filter((word) => word.length > 0)
    .map((word) => {
      const firstCharacter = word.charAt(0).toLocaleUpperCase("vi-VN");
      const remainingCharacters = word.slice(1).toLocaleLowerCase("vi-VN");
      return `${firstCharacter}${remainingCharacters}`;
    })
    .join(" ");
}

/**
 * Normalizes a full name into unspaced ASCII PascalCase form for Discord nicknames.
 *
 * @param rawFullName the raw or Title Case full name
 * @returns the normalized PascalCase name string without spaces or accents
 */
function toPascalCaseAsciiName(rawFullName: string): string {
  const stripped = stripVietnameseDiacritics(rawFullName).trim();
  if (stripped.length === 0) {
    return "";
  }

  return stripped
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => {
      const firstCharacter = word.charAt(0).toUpperCase();
      const remainingCharacters = word.slice(1).toLowerCase();
      return `${firstCharacter}${remainingCharacters}`;
    })
    .join("");
}

/**
 * Validates a raw full name and normalizes it to Title Case (for storage) and PascalCase (for nicknames).
 *
 * @param rawFullName the raw full name submitted by the user
 * @param fullNameRegexPattern the Unicode regex pattern from config.yaml
 * @returns a typed validation result containing Title Case and PascalCase forms or an error message
 */
function validateFullName(
  rawFullName: string,
  fullNameRegexPattern: string,
): FullNameValidationResult {
  const genericError =
    "The provided full name is invalid. Please double-check and try again.";
  const trimmed = rawFullName.normalize("NFC").trim().replaceAll(/\s+/g, " ");
  const fullNameRegex = new RegExp(fullNameRegexPattern, "u");
  if (!fullNameRegex.test(trimmed)) {
    return {
      valid: false,
      error: genericError,
    };
  }

  const words = trimmed.split(" ").filter((word) => word.length > 0);
  if (words.length < 2) {
    return {
      valid: false,
      error: genericError,
    };
  }

  const formattedFullName = toTitleCaseFullName(trimmed);
  const pascalName = toPascalCaseAsciiName(formattedFullName);
  if (pascalName.length < 2) {
    return {
      valid: false,
      error: genericError,
    };
  }

  return { valid: true, formattedFullName, pascalName };
}

/**
 * Validates student identifier syntax and checks whether its cohort is permitted.
 *
 * @param rawStudentId the raw student identifier submitted by the user
 * @param botConfig the bot configuration section from config.yaml
 * @returns a typed validation result containing uppercase studentId and cohort digits
 */
function validateStudentId(
  rawStudentId: string,
  botConfig: BotConfig,
): StudentIdValidationResult {
  const genericError =
    "The provided Student ID is invalid or not eligible for this recruitment cycle. Please double-check your information or contact support.";
  const normalizedId = rawStudentId.trim().toUpperCase();
  const pattern = new RegExp(botConfig.studentIdRegex);
  const match = pattern.exec(normalizedId);
  if (!match) {
    return {
      valid: false,
      error: genericError,
    };
  }

  const prefix = normalizedId.slice(0, 2);
  if (!botConfig.allowedStudentIdPrefixes.includes(prefix)) {
    return {
      valid: false,
      error: genericError,
    };
  }

  const cohort = match[1];
  if (!cohort || !botConfig.allowedCohorts.includes(cohort)) {
    return {
      valid: false,
      error: genericError,
    };
  }

  return { valid: true, studentId: normalizedId, cohort };
}

/**
 * Formats a standardized recruitment or staff nickname from a Title Case full name and student ID.
 *
 * @param fullName the stored Title Case full name
 * @param studentId the stored uppercase student identifier
 * @param botConfig the bot configuration section from config.yaml
 * @param prefixOverride optional prefix overriding clubCohortPrefix (for example, MOD or SUP)
 * @returns the rendered nickname string
 */
function formatNickname(
  fullName: string,
  studentId: string,
  botConfig: BotConfig,
  prefixOverride?: string,
): string {
  const pascalName = toPascalCaseAsciiName(fullName);
  const activePrefix = prefixOverride ?? botConfig.clubCohortPrefix;
  return botConfig.nicknameTemplate
    .replaceAll("{prefix}", activePrefix)
    .replaceAll("{name}", pascalName)
    .replaceAll("{studentId}", studentId);
}

/**
 * Escapes literal regular expression metacharacters in a template or prefix string.
 *
 * @param value raw string segment
 * @returns escaped regular expression pattern string
 */
function escapeRegExpLiteral(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrites the prefix of an existing standardized nickname while preserving name and student ID.
 *
 * @param currentNickname the member's current guild nickname
 * @param botConfig the bot configuration section from config.yaml
 * @param nextPrefix the target prefix (for example, MOD, SUP, or clubCohortPrefix)
 * @returns the updated nickname, or null if currentNickname is not standardized
 */
function rewriteStandardizedNicknamePrefix(
  currentNickname: string | null,
  botConfig: BotConfig,
  nextPrefix: string,
): string | null {
  if (!currentNickname) {
    return null;
  }

  const knownPrefixes = Array.from(
    new Set([
      botConfig.clubCohortPrefix,
      botConfig.moderatorPrefix,
      botConfig.supporterPrefix,
    ]),
  ).map((prefix) => escapeRegExpLiteral(prefix));

  const templatePattern = escapeRegExpLiteral(botConfig.nicknameTemplate)
    .replaceAll("\\{prefix\\}", `(${knownPrefixes.join("|")})`)
    .replaceAll("\\{name\\}", "([A-Za-z]{2,})")
    .replaceAll("\\{studentId\\}", "([A-Za-z0-9]+)");

  const match = new RegExp(`^${templatePattern}$`).exec(currentNickname.trim());
  if (!match?.[2] || !match[3]) {
    return null;
  }

  const normalizedStudentId = match[3].toUpperCase();
  if (!new RegExp(botConfig.studentIdRegex).test(normalizedStudentId)) {
    return null;
  }

  return botConfig.nicknameTemplate
    .replaceAll("{prefix}", nextPrefix)
    .replaceAll("{name}", match[2])
    .replaceAll("{studentId}", normalizedStudentId);
}

/**
 * Checks whether a guild nickname conforms to the configured standardized nickname template.
 *
 * @param currentNickname the member's current guild nickname
 * @param botConfig the bot configuration section from config.yaml
 * @returns true when the nickname matches any configured prefix and student ID format
 */
function hasStandardizedNickname(
  currentNickname: string | null,
  botConfig: BotConfig,
): boolean {
  return (
    rewriteStandardizedNicknamePrefix(
      currentNickname,
      botConfig,
      botConfig.clubCohortPrefix,
    ) !== null
  );
}

/**
 * Validates full name, student identifier, cohort eligibility, and Discord's 32-character limit.
 *
 * @param rawFullName the raw full name input
 * @param rawStudentId the raw student identifier input
 * @param botConfig the bot configuration section from config.yaml
 * @returns a validation result containing the final nickname or an exact length limit error
 */
function buildValidatedNickname(
  rawFullName: string,
  rawStudentId: string,
  botConfig: BotConfig,
): NicknameValidationResult {
  const nameResult = validateFullName(rawFullName, botConfig.fullNameRegex);
  if (!nameResult.valid) {
    return {
      valid: false,
      reason: "INVALID_INPUT",
      error: nameResult.error,
    };
  }

  const idResult = validateStudentId(rawStudentId, botConfig);
  if (!idResult.valid) {
    return {
      valid: false,
      reason: "INVALID_INPUT",
      error: idResult.error,
    };
  }

  const nickname = formatNickname(
    nameResult.formattedFullName,
    idResult.studentId,
    botConfig,
  );
  const longestPrefix = [
    botConfig.clubCohortPrefix,
    botConfig.moderatorPrefix,
    botConfig.supporterPrefix,
  ].reduce((longest, current) =>
    current.length > longest.length ? current : longest,
  );
  const maxLengthCandidate = formatNickname(
    nameResult.formattedFullName,
    idResult.studentId,
    botConfig,
    longestPrefix,
  );
  const fixedEnvelopeLength = formatNickname(
    "",
    idResult.studentId,
    botConfig,
    longestPrefix,
  ).length;
  const maxAllowedNameLength =
    botConfig.maxNicknameLength - fixedEnvelopeLength;

  if (maxLengthCandidate.length > botConfig.maxNicknameLength) {
    return {
      valid: false,
      reason: "NICKNAME_TOO_LONG",
      pascalName: nameResult.pascalName,
      currentNameLength: nameResult.pascalName.length,
      maxAllowedNameLength,
      error: `Your normalized nickname name "${nameResult.pascalName}" is ${String(nameResult.pascalName.length)} characters long, which causes the final nickname (${String(maxLengthCandidate.length)} characters) to exceed Discord's ${String(botConfig.maxNicknameLength)}-character limit. Your normalized name must be ${String(maxAllowedNameLength)} characters or fewer.`,
    };
  }

  return {
    valid: true,
    studentId: idResult.studentId,
    formattedFullName: nameResult.formattedFullName,
    pascalName: nameResult.pascalName,
    nickname,
    cohort: idResult.cohort,
  };
}

/**
 * Replaces dynamic {prefix} and {cohorts} placeholders in configured UI copy.
 *
 * @param template the raw message template from config.yaml
 * @param botConfig the bot configuration section from config.yaml
 * @returns the interpolated string
 */
function interpolateConfigText(template: string, botConfig: BotConfig): string {
  const cohortsLabel = botConfig.allowedCohorts
    .map((code) => `K${code}`)
    .join(", ");
  return template
    .replaceAll("{prefix}", botConfig.clubCohortPrefix)
    .replaceAll("{cohorts}", cohortsLabel);
}

/**
 * Parses inline Discord user mentions and student identifiers from bulk command filters.
 *
 * @param rawInput the space, comma, or semicolon delimited string supplied to a slash command
 * @returns separated arrays of unique Discord user IDs and uppercase student IDs
 */
function parseTargetTokens(rawInput: string): ParsedTargetTokens {
  const discordIdSet = new Set<string>();
  const studentIdSet = new Set<string>();

  const mentionPattern = /<@!?(\d{17,20})>/g;
  let strippedInput = rawInput;

  for (const match of rawInput.matchAll(mentionPattern)) {
    const capturedId = match[1];
    if (capturedId) {
      discordIdSet.add(capturedId);
    }
    strippedInput = strippedInput.replace(match[0], " ");
  }

  const rawTokens = strippedInput
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  for (const token of rawTokens) {
    if (/^\d{17,20}$/.test(token)) {
      discordIdSet.add(token);
    } else {
      studentIdSet.add(token.toUpperCase());
    }
  }

  return {
    discordIds: Array.from(discordIdSet),
    studentIds: Array.from(studentIdSet),
  };
}

/**
 * Centralizes stateless Unicode normalization, cohort verification, and nickname checks.
 */
export const InputValidator = {
  stripVietnameseDiacritics,
  toTitleCaseFullName,
  toPascalCaseAsciiName,
  validateFullName,
  validateStudentId,
  formatNickname,
  rewriteStandardizedNicknamePrefix,
  hasStandardizedNickname,
  buildValidatedNickname,
  interpolateConfigText,
  parseTargetTokens,
} as const;
