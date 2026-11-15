import type { BotConfig } from '../config/ConfigSchema.js';

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
      reason: 'INVALID_INPUT' | 'NICKNAME_TOO_LONG';
      error: string;
      pascalName?: string;
      currentNameLength?: number;
      maxAllowedNameLength?: number;
    };

/**
 * Result returned when validating a raw student identifier string.
 */
export type StudentIdValidationResult =
  { valid: true; studentId: string; cohort: string } | { valid: false; error: string };

/**
 * Result returned when validating a raw full name string.
 */
export type FullNameValidationResult =
  { valid: true; formattedFullName: string; pascalName: string } | { valid: false; error: string };

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
    .replaceAll('Đ', 'D')
    .replaceAll('đ', 'd')
    .normalize('NFD')
    .replaceAll(/\p{Mn}/gu, '');
}

/**
 * Normalizes a full name into Title Case while preserving Vietnamese diacritics.
 *
 * @param rawFullName the raw full name input
 * @returns the normalized Title Case full name separated by single spaces
 */
function toTitleCaseFullName(rawFullName: string): string {
  const collapsed = rawFullName.normalize('NFC').trim().replaceAll(/\s+/g, ' ');
  if (collapsed.length === 0) {
    return '';
  }

  return collapsed
    .split(' ')
    .filter((word) => word.length > 0)
    .map((word) => {
      const firstCharacter = word.charAt(0).toLocaleUpperCase('vi-VN');
      const remainingCharacters = word.slice(1).toLocaleLowerCase('vi-VN');
      return `${firstCharacter}${remainingCharacters}`;
    })
    .join(' ');
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
    return '';
  }

  return stripped
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => {
      const firstCharacter = word.charAt(0).toUpperCase();
      const remainingCharacters = word.slice(1).toLowerCase();
      return `${firstCharacter}${remainingCharacters}`;
    })
    .join('');
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
  const trimmed = rawFullName.normalize('NFC').trim().replaceAll(/\s+/g, ' ');
  const fullNameRegex = new RegExp(fullNameRegexPattern, 'u');
  if (!fullNameRegex.test(trimmed)) {
    return {
      valid: false,
      error: 'Full name must contain only alphabetic characters and spaces (2 to 60 characters).',
    };
  }

  const words = trimmed.split(' ').filter((word) => word.length > 0);
  if (words.length < 2) {
    return {
      valid: false,
      error: 'Please enter your complete full name containing at least two words.',
    };
  }

  const formattedFullName = toTitleCaseFullName(trimmed);
  const pascalName = toPascalCaseAsciiName(formattedFullName);
  if (pascalName.length < 2) {
    return {
      valid: false,
      error: 'Full name could not be normalized into valid ASCII alphabetic characters.',
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
function validateStudentId(rawStudentId: string, botConfig: BotConfig): StudentIdValidationResult {
  const normalizedId = rawStudentId.trim().toUpperCase();
  const pattern = new RegExp(botConfig.studentIdRegex);
  const match = pattern.exec(normalizedId);
  if (!match) {
    return {
      valid: false,
      error:
        'Student ID must follow the official format of two letters followed by six digits (for example, SE220001).',
    };
  }

  const prefix = normalizedId.slice(0, 2);
  if (!botConfig.allowedStudentIdPrefixes.includes(prefix)) {
    const allowedPrefixLabels = botConfig.allowedStudentIdPrefixes.join(', ');
    return {
      valid: false,
      error: `Student ID prefix \`${prefix}\` is not recognized for FPTU HCMC. Allowed prefixes: ${allowedPrefixLabels}.`,
    };
  }

  const cohort = match[1];
  if (!cohort || !botConfig.allowedCohorts.includes(cohort)) {
    const allowedLabels = botConfig.allowedCohorts.map((code) => `K${code}`).join(', ');
    return {
      valid: false,
      error: `Student ID cohort K${cohort ?? '??'} is not eligible for this recruitment cycle. Allowed cohorts: ${allowedLabels}.`,
    };
  }

  return { valid: true, studentId: normalizedId, cohort };
}

/**
 * Formats a standardized recruitment nickname from a stored Title Case full name and student ID.
 *
 * @param fullName the stored Title Case full name
 * @param studentId the stored uppercase student identifier
 * @param botConfig the bot configuration section from config.yaml
 * @returns the rendered nickname string
 */
function formatNickname(fullName: string, studentId: string, botConfig: BotConfig): string {
  const pascalName = toPascalCaseAsciiName(fullName);
  return botConfig.nicknameTemplate
    .replaceAll('{prefix}', botConfig.clubCohortPrefix)
    .replaceAll('{name}', pascalName)
    .replaceAll('{studentId}', studentId);
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
      reason: 'INVALID_INPUT',
      error: nameResult.error,
    };
  }

  const idResult = validateStudentId(rawStudentId, botConfig);
  if (!idResult.valid) {
    return {
      valid: false,
      reason: 'INVALID_INPUT',
      error: idResult.error,
    };
  }

  const nickname = formatNickname(nameResult.formattedFullName, idResult.studentId, botConfig);
  const fixedEnvelopeLength = formatNickname('', idResult.studentId, botConfig).length;
  const maxAllowedNameLength = botConfig.maxNicknameLength - fixedEnvelopeLength;

  if (nickname.length > botConfig.maxNicknameLength) {
    return {
      valid: false,
      reason: 'NICKNAME_TOO_LONG',
      pascalName: nameResult.pascalName,
      currentNameLength: nameResult.pascalName.length,
      maxAllowedNameLength,
      error: `Your normalized nickname name "${nameResult.pascalName}" is ${nameResult.pascalName.length} characters long, which causes the final nickname (${nickname.length} characters) to exceed Discord's ${botConfig.maxNicknameLength}-character limit. Your normalized name must be ${maxAllowedNameLength} characters or fewer.`,
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
  const cohortsLabel = botConfig.allowedCohorts.map((code) => `K${code}`).join(', ');
  return template
    .replaceAll('{prefix}', botConfig.clubCohortPrefix)
    .replaceAll('{cohorts}', cohortsLabel);
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
    strippedInput = strippedInput.replace(match[0], ' ');
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
  buildValidatedNickname,
  interpolateConfigText,
  parseTargetTokens,
} as const;
