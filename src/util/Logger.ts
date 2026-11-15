import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';
import pinoPretty from 'pino-pretty';
import type { LoggingConfig } from '../config/ConfigSchema.js';

/**
 * Log severity levels supported by the application logger.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Writable stream that appends structured JSON logs into daily YYYY-MM-DD.log files
 * and rotates automatically when the local calendar date changes.
 */
class DailyLogDestination extends Writable {
  private readonly directory: string;
  private currentDate = '';
  private fileStream: fs.WriteStream | null = null;

  /**
   * Creates a daily-rotating file destination in the target directory.
   *
   * @param directory target directory path for daily log files
   */
  public constructor(directory: string) {
    super();
    this.directory = path.resolve(directory);
  }

  /**
   * Formats a Date instance into a local YYYY-MM-DD string.
   *
   * @param date the date to format
   * @returns local calendar date string
   */
  private formatLocalDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Ensures an open write stream exists for today's date, rotating if the date changed.
   */
  private ensureCurrentStream(): fs.WriteStream {
    const today = this.formatLocalDate(new Date());
    if (this.fileStream !== null && this.currentDate === today) {
      return this.fileStream;
    }

    if (this.fileStream !== null) {
      this.fileStream.end();
      this.fileStream = null;
    }

    fs.mkdirSync(this.directory, { recursive: true });
    const filePath = path.join(this.directory, `${today}.log`);
    this.fileStream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
    this.currentDate = today;
    return this.fileStream;
  }

  /**
   * Writes a log chunk to the active daily log file.
   *
   * @param chunk encoded log line buffer or string
   * @param _encoding chunk encoding
   * @param callback completion callback
   */
  public override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      const stream = this.ensureCurrentStream();
      if (!stream.write(chunk)) {
        stream.once('drain', () => callback());
        return;
      }
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Closes the underlying file stream when the destination is destroyed.
   *
   * @param err optional stream error
   * @param callback completion callback
   */
  public override _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    if (this.fileStream !== null) {
      this.fileStream.end(() => callback(err));
      this.fileStream = null;
      return;
    }
    callback(err);
  }
}

/**
 * Builds a default pretty console Pino instance for early startup before config.yaml is loaded.
 *
 * @returns configured startup Pino logger
 */
function createStartupLogger(): PinoLogger {
  const prettyStream = pinoPretty({
    colorize: true,
    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
    ignore: 'pid,hostname',
  }) as unknown as DestinationStream;

  return pino({ level: 'info' }, prettyStream);
}

let pinoInstance: PinoLogger = createStartupLogger();

/**
 * Reconfigures the logger outputs and threshold from validated config.yaml logging settings.
 *
 * @param config validated logging configuration block
 */
function configure(config: LoggingConfig): void {
  const streams: Array<{ level: LogLevel; stream: DestinationStream }> = [];

  if (config.console) {
    const prettyStream = pinoPretty({
      colorize: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
      ignore: 'pid,hostname',
    }) as unknown as DestinationStream;
    streams.push({ level: config.level, stream: prettyStream });
  }

  if (config.file) {
    streams.push({
      level: config.level,
      stream: new DailyLogDestination(config.directory),
    });
  }

  if (streams.length === 0) {
    pinoInstance = pino({ enabled: false });
    return;
  }

  pinoInstance = pino({ level: config.level }, pino.multistream(streams));
}

/**
 * Emits a debug-level structured log entry.
 *
 * @param context the module or component name emitting the message
 * @param message the human-readable log statement
 * @param meta optional structured metadata fields
 */
function debug(context: string, message: string, meta?: Record<string, unknown>): void {
  pinoInstance.debug({ context, ...(meta ?? {}) }, message);
}

/**
 * Emits an info-level structured log entry.
 *
 * @param context the module or component name emitting the message
 * @param message the human-readable log statement
 * @param meta optional structured metadata fields
 */
function info(context: string, message: string, meta?: Record<string, unknown>): void {
  pinoInstance.info({ context, ...(meta ?? {}) }, message);
}

/**
 * Emits a warn-level structured log entry.
 *
 * @param context the module or component name emitting the warning
 * @param message the warning description
 * @param meta optional structured metadata fields
 */
function warn(context: string, message: string, meta?: Record<string, unknown>): void {
  pinoInstance.warn({ context, ...(meta ?? {}) }, message);
}

/**
 * Emits an error-level structured log entry with optional error object or metadata.
 *
 * @param context the module or component name where the error occurred
 * @param message the error description
 * @param errorValue optional Error instance, metadata object, or primitive detail
 */
function error(context: string, message: string, errorValue?: unknown): void {
  if (errorValue instanceof Error) {
    pinoInstance.error({ context, err: errorValue }, message);
    return;
  }
  if (typeof errorValue === 'object' && errorValue !== null) {
    pinoInstance.error({ context, ...(errorValue as Record<string, unknown>) }, message);
    return;
  }
  if (errorValue !== undefined) {
    const detail =
      typeof errorValue === 'string' ||
      typeof errorValue === 'number' ||
      typeof errorValue === 'boolean'
        ? String(errorValue)
        : JSON.stringify(errorValue);
    pinoInstance.error({ context, detail }, message);
    return;
  }
  pinoInstance.error({ context }, message);
}

/**
 * Structured Pino logger supporting pretty console output and midnight-rotating daily JSON log files.
 */
export const Logger = {
  configure,
  debug,
  info,
  warn,
  error,
} as const;
