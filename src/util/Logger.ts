import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { Client } from 'discord.js';
import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';
import pinoPretty from 'pino-pretty';

/**
 * Log severity levels supported by the application logger.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Configuration shape for 3-tier independent logging (file, console, discord).
 */
export interface ThreeTierLoggingConfig {
  file: {
    enabled: boolean;
    level: LogLevel;
    directory: string;
    maxFiles: number;
  };
  console: {
    enabled: boolean;
    level: LogLevel;
  };
  discord: {
    enabled: boolean;
    level: LogLevel;
    channelId: string;
  };
}

/**
 * Legacy flat logging config supported temporarily during incremental commits.
 */
interface LegacyLoggingConfig {
  level: LogLevel;
  console: boolean;
  file: boolean;
  directory: string;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_NAMES: Record<number, string> = {
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
};

let attachedDiscordClient: Client | null = null;

/**
 * Writable stream that appends structured JSON logs into daily YYYY-MM-DD.log files,
 * rotates at midnight, and prunes oldest files beyond maxFiles.
 */
class DailyLogDestination extends Writable {
  private readonly directory: string;
  private readonly maxFiles: number;
  private currentDate = '';
  private fileStream: fs.WriteStream | null = null;

  /**
   * Creates a daily-rotating file destination with automatic retention pruning.
   *
   * @param directory target directory path for daily log files
   * @param maxFiles maximum number of daily log files to retain
   */
  public constructor(directory: string, maxFiles: number) {
    super();
    this.directory = path.resolve(directory);
    this.maxFiles = Math.max(1, maxFiles);
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
   * Removes oldest YYYY-MM-DD.log files when the directory exceeds maxFiles.
   */
  private pruneOldLogFiles(): void {
    if (!fs.existsSync(this.directory)) {
      return;
    }

    const logFiles = fs
      .readdirSync(this.directory)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.log$/.test(name))
      .sort();

    while (logFiles.length > this.maxFiles) {
      const oldest = logFiles.shift();
      if (oldest) {
        fs.unlinkSync(path.join(this.directory, oldest));
      }
    }
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
    this.pruneOldLogFiles();
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
 * Writable stream that batches structured log lines over a short window
 * and forwards them to a configured Discord text channel.
 */
class DiscordLogDestination extends Writable {
  private static readonly FLUSH_DELAY_MS = 2500;
  private static readonly MAX_CHUNK_LENGTH = 1850;
  private static readonly MAX_PENDING_LINES = 100;
  private readonly channelId: string;
  private readonly buffer: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  /**
   * Creates a batched Discord channel log destination.
   *
   * @param channelId target Discord text channel snowflake ID
   */
  public constructor(channelId: string) {
    super();
    this.channelId = channelId;
  }

  /**
   * Formats a raw Pino JSON line into a concise readable log line for Discord.
   *
   * @param rawLine raw JSON line emitted by Pino
   * @returns formatted single-line string
   */
  private formatLogLine(rawLine: string): string {
    try {
      const parsed = JSON.parse(rawLine) as Record<string, unknown>;
      const levelNum = typeof parsed.level === 'number' ? parsed.level : 30;
      const levelLabel = LEVEL_NAMES[levelNum] ?? 'INFO';
      const context = typeof parsed.context === 'string' ? parsed.context : 'System';
      const msg = typeof parsed.msg === 'string' ? parsed.msg : '';
      const timeMs = typeof parsed.time === 'number' ? parsed.time : Date.now();
      const timestamp = new Date(timeMs).toISOString().replace('T', ' ').slice(0, 19);

      const extraEntries = Object.entries(parsed).filter(
        ([key]) =>
          key !== 'level' &&
          key !== 'time' &&
          key !== 'pid' &&
          key !== 'hostname' &&
          key !== 'context' &&
          key !== 'msg',
      );
      const extraSuffix =
        extraEntries.length > 0
          ? ` | ${extraEntries.map(([key, val]) => `${key}=${typeof val === 'string' ? val : JSON.stringify(val)}`).join(' ')}`
          : '';

      return `[${timestamp}] [${levelLabel}] [${context}] ${msg}${extraSuffix}`;
    } catch {
      return rawLine.trim();
    }
  }

  /**
   * Flushes buffered log lines to the configured Discord channel in safe character chunks.
   */
  private async flush(): Promise<void> {
    this.flushTimer = null;
    if (!attachedDiscordClient || !attachedDiscordClient.isReady() || this.buffer.length === 0) {
      return;
    }

    const lines = this.buffer.splice(0, this.buffer.length);
    const channel = await attachedDiscordClient.channels.fetch(this.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      return;
    }

    let currentBlock = '';
    const blocks: string[] = [];

    for (const line of lines) {
      const safeLine = line.slice(0, DiscordLogDestination.MAX_CHUNK_LENGTH);
      if (currentBlock.length + safeLine.length + 1 > DiscordLogDestination.MAX_CHUNK_LENGTH) {
        if (currentBlock.length > 0) {
          blocks.push(currentBlock);
        }
        currentBlock = safeLine;
      } else {
        currentBlock = currentBlock.length > 0 ? `${currentBlock}\n${safeLine}` : safeLine;
      }
    }
    if (currentBlock.length > 0) {
      blocks.push(currentBlock);
    }

    for (const block of blocks) {
      await channel.send({ content: `\`\`\`\n${block}\n\`\`\`` }).catch((err: unknown) => {
        process.stderr.write(`DiscordLogDestination send failed: ${String(err)}\n`);
      });
    }
  }

  /**
   * Queues an incoming Pino log chunk for batched Discord delivery.
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
    const text = chunk.toString('utf8').trim();
    if (text.length > 0) {
      for (const line of text.split('\n')) {
        this.buffer.push(this.formatLogLine(line));
      }
      if (this.buffer.length > DiscordLogDestination.MAX_PENDING_LINES) {
        this.buffer.splice(0, this.buffer.length - DiscordLogDestination.MAX_PENDING_LINES);
      }
      if (this.flushTimer === null) {
        this.flushTimer = setTimeout(() => {
          void this.flush();
        }, DiscordLogDestination.FLUSH_DELAY_MS);
        this.flushTimer.unref();
      }
    }
    callback();
  }

  /**
   * Clears pending flush timers when the destination is destroyed.
   *
   * @param err optional stream error
   * @param callback completion callback
   */
  public override _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    callback(err);
  }
}

/**
 * Normalizes legacy or 3-tier logging config into a uniform ThreeTierLoggingConfig.
 *
 * @param config incoming logging configuration object
 * @returns normalized 3-tier logging configuration
 */
function normalizeConfig(
  config: ThreeTierLoggingConfig | LegacyLoggingConfig,
): ThreeTierLoggingConfig {
  if ('file' in config && typeof config.file === 'object') {
    return config;
  }
  return {
    file: {
      enabled: config.file,
      level: config.level,
      directory: config.directory,
      maxFiles: 14,
    },
    console: {
      enabled: config.console,
      level: config.level,
    },
    discord: {
      enabled: false,
      level: 'info',
      channelId: '',
    },
  };
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
 * Attaches the ready Discord client so discord-tier logs can be forwarded to the configured channel.
 *
 * @param client the logged-in Discord.js Client instance
 */
function attachDiscordClient(client: Client): void {
  attachedDiscordClient = client;
}

/**
 * Reconfigures the logger outputs and independent severity thresholds from config.yaml.
 *
 * @param rawConfig validated logging configuration block
 */
function configure(rawConfig: ThreeTierLoggingConfig | LegacyLoggingConfig): void {
  const config = normalizeConfig(rawConfig);
  const streams: Array<{ level: LogLevel; stream: DestinationStream }> = [];
  const enabledLevels: LogLevel[] = [];

  if (config.file.enabled) {
    enabledLevels.push(config.file.level);
    streams.push({
      level: config.file.level,
      stream: new DailyLogDestination(config.file.directory, config.file.maxFiles),
    });
  }

  if (config.console.enabled) {
    enabledLevels.push(config.console.level);
    const prettyStream = pinoPretty({
      colorize: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
      ignore: 'pid,hostname',
    }) as unknown as DestinationStream;
    streams.push({ level: config.console.level, stream: prettyStream });
  }

  if (config.discord.enabled && config.discord.channelId.trim().length > 0) {
    enabledLevels.push(config.discord.level);
    streams.push({
      level: config.discord.level,
      stream: new DiscordLogDestination(config.discord.channelId),
    });
  }

  if (streams.length === 0) {
    pinoInstance = pino({ enabled: false });
    return;
  }

  const lowestLevel = enabledLevels.reduce((lowest, current) =>
    LEVEL_PRIORITY[current] < LEVEL_PRIORITY[lowest] ? current : lowest,
  );

  pinoInstance = pino({ level: lowestLevel }, pino.multistream(streams));
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
 * Structured 3-tier Pino logger supporting daily file retention, pretty console, and Discord batching.
 */
export const Logger = {
  attachDiscordClient,
  configure,
  debug,
  info,
  warn,
  error,
} as const;
