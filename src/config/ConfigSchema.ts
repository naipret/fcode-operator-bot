import { z } from 'zod';

/**
 * Zod schema validating a required Discord Snowflake ID string.
 */
const snowflakeSchema = z
  .string({ error: 'Required ID is missing.' })
  .trim()
  .min(1, 'Required ID is empty; fill in this field.')
  .regex(/^\d{17,20}$/, 'Must be a valid Discord Snowflake ID (17 to 20 digits).');

const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

/**
 * Zod schema validating the root config.yaml structure.
 */
export const appConfigSchema = z.object({
  bot: z.object({
    clubCohortPrefix: z.string().trim().min(1).max(8),
    maxNicknameLength: z.number().int().min(16).max(32),
    allowedCohorts: z.array(z.string().regex(/^\d{2}$/)).min(1),
    allowedStudentIdPrefixes: z
      .array(
        z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z]{2}$/),
      )
      .min(1),
    studentIdRegex: z.string().min(1),
    fullNameRegex: z.string().min(1),
    nicknameTemplate: z.string().includes('{prefix}').includes('{name}').includes('{studentId}'),
  }),
  verification: z.object({
    enabledByDefault: z.boolean(),
    defaultRound: z.enum(['none', 'round-1', 'round-2', 'round-3']),
  }),
  permissions: z.object({
    ownerRoleId: snowflakeSchema,
    moderatorRoleId: snowflakeSchema,
    verifiedRoleId: snowflakeSchema,
    roundRoleIds: z.object({
      round1: snowflakeSchema,
      round2: snowflakeSchema,
      round3: snowflakeSchema,
    }),
  }),
  database: z.object({
    directory: z.string().trim().min(1),
    sync: z.object({
      enabled: z.boolean(),
      intervalMinutes: z.number().int().min(1),
    }),
    backup: z.object({
      enabled: z.boolean(),
      directory: z.string().trim().min(1),
      intervalMinutes: z.number().int().min(1),
      maxFiles: z.number().int().min(1),
    }),
  }),
  logging: z
    .object({
      file: z.object({
        enabled: z.boolean(),
        level: logLevelSchema,
        directory: z.string().trim().min(1),
        maxFiles: z.number().int().min(1),
      }),
      console: z.object({
        enabled: z.boolean(),
        level: logLevelSchema,
      }),
      discord: z.object({
        enabled: z.boolean(),
        level: logLevelSchema,
        channelId: z.string().trim(),
      }),
    })
    .superRefine((logging, ctx) => {
      if (logging.discord.enabled && !/^\d{17,20}$/.test(logging.discord.channelId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['discord', 'channelId'],
          message:
            'logging.discord.channelId must be a valid Discord Snowflake ID (17 to 20 digits) when Discord logging is enabled.',
        });
      }
    }),
  messages: z.object({
    verificationPanelTitle: z.string().min(1),
    verificationPanelDescription: z.string().min(1),
    verificationPanelButtonLabel: z.string().min(1),
    verificationClosedMessage: z.string().min(1),
    verificationSuccessTitle: z.string().min(1),
    verificationAlreadyVerifiedTitle: z.string().min(1),
    verificationRestoredTitle: z.string().min(1),
    verificationErrorTitle: z.string().min(1),
  }),
});

/**
 * Zod schema validating required and optional runtime environment variables.
 */
export const environmentSchema = z.object({
  DISCORD_APPLICATION_TOKEN: z
    .string({ error: 'DISCORD_APPLICATION_TOKEN is missing.' })
    .trim()
    .min(10, 'DISCORD_APPLICATION_TOKEN is empty or invalid.'),
  DISCORD_APPLICATION_ID: snowflakeSchema,
  DISCORD_SERVER_ID: snowflakeSchema,
  CONFIG_PATH: z.string().trim().min(1).default('./config.yaml'),
});

/**
 * Strongly typed application configuration derived from appConfigSchema.
 */
export type AppConfig = z.infer<typeof appConfigSchema>;

/**
 * Strongly typed bot naming and validation configuration subset.
 */
export type BotConfig = AppConfig['bot'];

/**
 * Strongly typed logging configuration subset.
 */
export type LoggingConfig = AppConfig['logging'];

/**
 * Strongly typed runtime environment configuration derived from environmentSchema.
 */
export type EnvironmentConfig = z.infer<typeof environmentSchema>;
