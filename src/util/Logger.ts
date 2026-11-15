/**
 * Log severity levels supported by the application console logger.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Writes the formatted log line to the appropriate process output stream.
 *
 * @param level the severity tag
 * @param context the source component identifier
 * @param message the formatted message text
 */
function writeLog(level: LogLevel, context: string, message: string): void {
  const timestamp = new Date().toISOString();
  const formattedLine = `[${timestamp}] [${level.toUpperCase()}] [${context}] ${message}`;
  if (level === 'error') {
    console.error(formattedLine);
    return;
  }
  if (level === 'warn') {
    console.warn(formattedLine);
    return;
  }
  console.log(formattedLine);
}

/**
 * Formats and prints a timestamped informational message.
 *
 * @param context the module or component name emitting the message
 * @param message the human-readable log statement
 */
function info(context: string, message: string): void {
  writeLog('info', context, message);
}

/**
 * Formats and prints a timestamped warning message.
 *
 * @param context the module or component name emitting the warning
 * @param message the warning description
 */
function warn(context: string, message: string): void {
  writeLog('warn', context, message);
}

/**
 * Formats and prints a timestamped error message with optional error details.
 *
 * @param context the module or component name where the error occurred
 * @param message the error description
 * @param error optional error value to serialize alongside the message
 */
function error(context: string, message: string, error?: unknown): void {
  const suffix =
    error instanceof Error
      ? ` | ${error.message}`
      : error !== undefined
        ? ` | ${typeof error === 'string' ? error : JSON.stringify(error)}`
        : '';
  writeLog('error', context, `${message}${suffix}`);
}

/**
 * Writes structured ISO-8601 log messages to stdout and stderr without external dependencies.
 */
export const Logger = {
  info,
  warn,
  error,
} as const;
