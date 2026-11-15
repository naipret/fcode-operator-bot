import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { z } from 'zod';
import {
  type AppConfig,
  type EnvironmentConfig,
  appConfigSchema,
  environmentSchema,
} from './ConfigSchema.js';

let cachedConfig: AppConfig | null = null;

/**
 * Formats Zod validation issues into an itemized multi-line report.
 *
 * @param issues the list of Zod validation issues
 * @returns formatted multi-line error bullet list
 */
function formatValidationIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const fieldPath = issue.path.length > 0 ? issue.path.join('.') : 'root';
      return `  - ${fieldPath}: ${issue.message}`;
    })
    .join('\n');
}

/**
 * Loads and validates config.yaml from the specified path or CONFIG_PATH environment variable.
 *
 * @param configPath optional filesystem path overriding CONFIG_PATH
 * @returns a validated AppConfig object
 * @throws Error if the YAML file does not exist or fails Zod schema validation
 */
function loadAppConfig(configPath?: string): AppConfig {
  const resolvedPath = path.resolve(configPath ?? process.env.CONFIG_PATH ?? './config.yaml');
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Configuration file not found at path: ${resolvedPath}`);
  }

  const rawContent = fs.readFileSync(resolvedPath, 'utf8');
  const parsedYaml: unknown = parse(rawContent);
  const validationResult = appConfigSchema.safeParse(parsedYaml);

  if (!validationResult.success) {
    throw new Error(
      `Configuration validation failed in ${resolvedPath}:\n${formatValidationIssues(validationResult.error.issues)}`,
    );
  }

  cachedConfig = validationResult.data;
  return validationResult.data;
}

/**
 * Returns the previously loaded AppConfig or loads it from disk on first call.
 *
 * @returns the validated AppConfig instance
 * @throws Error if loading from disk fails
 */
function getAppConfig(): AppConfig {
  if (cachedConfig !== null) {
    return cachedConfig;
  }
  return loadAppConfig();
}

/**
 * Validates required Discord credentials and runtime paths from process environment variables.
 *
 * @param envSource optional environment variable map defaulting to process.env
 * @returns a validated EnvironmentConfig object
 * @throws Error if any required environment variable is missing or malformed
 */
function loadEnvironment(
  envSource: Record<string, string | undefined> = process.env,
): EnvironmentConfig {
  const normalizedEnv = {
    ...envSource,
    CONFIG_PATH:
      envSource.CONFIG_PATH && envSource.CONFIG_PATH.trim().length > 0
        ? envSource.CONFIG_PATH
        : undefined,
  };
  const validationResult = environmentSchema.safeParse(normalizedEnv);
  if (!validationResult.success) {
    throw new Error(
      `Environment validation failed:\n${formatValidationIssues(validationResult.error.issues)}`,
    );
  }
  return validationResult.data;
}

/**
 * Resolves the SQLite database file path dynamically from the configured directory and club cohort prefix.
 *
 * @param appConfig the validated application configuration
 * @returns normalized path such as data/recruitment-f22.db
 */
function resolveDatabasePath(appConfig: AppConfig): string {
  const prefix = appConfig.bot.clubCohortPrefix.toLowerCase();
  return path.join(appConfig.database.directory, `recruitment-${prefix}.db`);
}

/**
 * Loads and validates YAML application configuration and runtime environment variables.
 */
export const ConfigLoader = {
  loadAppConfig,
  getAppConfig,
  loadEnvironment,
  resolveDatabasePath,
} as const;
