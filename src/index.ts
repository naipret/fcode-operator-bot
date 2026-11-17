import {
  type Client,
  Events,
  type Guild,
  type GuildMember,
  type Interaction,
  MessageFlags,
  REST,
  Routes,
} from "discord.js";
import { createDiscordClient } from "./client.js";
import { ConfigLoader } from "./config/ConfigLoader.js";
import type { AppConfig, EnvironmentConfig } from "./config/ConfigSchema.js";
import { RoundController } from "./controller/RoundController.js";
import { StudentController } from "./controller/StudentController.js";
import { VerificationController } from "./controller/VerificationController.js";
import { DatabaseClient } from "./repository/DatabaseClient.js";
import { StudentRepository } from "./repository/StudentRepository.js";
import { GuildResourceResolver } from "./util/GuildResourceResolver.js";
import { Logger } from "./util/Logger.js";
import { EmbedFactory } from "./view/EmbedFactory.js";
import { RoundCommandView } from "./view/RoundCommandView.js";
import { StudentCommandView } from "./view/StudentCommandView.js";
import {
  type ReloadOutcome,
  SystemCommandView,
} from "./view/SystemCommandView.js";
import { VerifyCommandView } from "./view/VerifyCommandView.js";

const SHUTDOWN_DRAIN_TIMEOUT_MS = 5000;
const SHUTDOWN_POLL_INTERVAL_MS = 50;

/**
 * Shared runtime container passed between bootstrap, reload, and shutdown helpers.
 */
interface RuntimeContext {
  environment: EnvironmentConfig;
  activeConfig: AppConfig;
  databaseClient: DatabaseClient;
  lockedDiscordIds: Set<string>;
  resourceResolver: GuildResourceResolver;
  verificationController: VerificationController;
  studentController: StudentController;
  verifyView: VerifyCommandView;
  studentView: StudentCommandView;
  roundView: RoundCommandView;
  systemView: SystemCommandView;
  backupTimer: NodeJS.Timeout | null;
}

/**
 * Registers the production guild slash commands via Discord REST API.
 *
 * @param token the Discord bot authentication token
 * @param applicationId the Discord application snowflake ID
 * @param guildId the target Discord guild snowflake ID
 * @param commandPayloads serialized slash command definitions
 */
async function registerGuildCommands(
  token: string,
  applicationId: string,
  guildId: string,
  commandPayloads: unknown[],
): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
    body: commandPayloads,
  });
  Logger.info(
    "Bootstrap",
    `Registered ${String(commandPayloads.length)} guild slash commands.`,
  );
}

/**
 * Routes chat-input slash command interactions to the owning MVC view.
 *
 * @param interaction the incoming interaction
 * @param verifyView verification command view
 * @param studentView student command view
 * @param roundView round command view
 * @param systemView system command view
 */
async function dispatchInteractionRoute(
  interaction: Interaction,
  verifyView: VerifyCommandView,
  studentView: StudentCommandView,
  roundView: RoundCommandView,
  systemView: SystemCommandView,
): Promise<void> {
  if (interaction.isChatInputCommand()) {
    switch (interaction.commandName) {
      case "verify":
        await verifyView.handleSlashCommand(interaction);
        return;
      case "student":
        await studentView.handleSlashCommand(interaction);
        return;
      case "round":
        await roundView.handleSlashCommand(interaction);
        return;
      case "system":
        await systemView.handleSlashCommand(interaction);
        return;
    }
    return;
  }

  if (interaction.isButton()) {
    if (verifyView.ownsCustomId(interaction.customId)) {
      await verifyView.handleVerifyButton(interaction);
    } else if (roundView.ownsCustomId(interaction.customId)) {
      await roundView.handleButton(interaction);
    }
    return;
  }

  if (interaction.isModalSubmit()) {
    if (verifyView.ownsCustomId(interaction.customId)) {
      await verifyView.handleModalSubmit(interaction);
    } else if (studentView.ownsCustomId(interaction.customId)) {
      await studentView.handleModalSubmit(interaction);
    }
    return;
  }

  if (
    interaction.isUserSelectMenu() &&
    roundView.ownsCustomId(interaction.customId)
  ) {
    await roundView.handleUserSelectMenu(interaction);
  }
}

/**
 * Dispatches Discord interactions to the appropriate MVC view handler with safe error handling.
 *
 * @param interaction the incoming Discord interaction
 * @param verifyView the verification command view
 * @param studentView the student command view
 * @param roundView the round command view
 * @param systemView the system command view
 */
async function dispatchInteraction(
  interaction: Interaction,
  verifyView: VerifyCommandView,
  studentView: StudentCommandView,
  roundView: RoundCommandView,
  systemView: SystemCommandView,
): Promise<void> {
  try {
    await dispatchInteractionRoute(
      interaction,
      verifyView,
      studentView,
      roundView,
      systemView,
    );
  } catch (error) {
    Logger.error(
      "InteractionDispatcher",
      "Unhandled error while processing interaction",
      error,
    );
    if (!interaction.isRepliable()) {
      return;
    }

    const errorEmbed = EmbedFactory.buildErrorEmbed(
      "Unexpected System Error",
      "An unexpected error occurred while processing your request. Please try again or contact a moderator.",
    );

    if (interaction.deferred || interaction.replied) {
      await interaction
        .editReply({ embeds: [errorEmbed], components: [] })
        .catch(() => undefined);
      return;
    }

    const isEphemeralFallback = !interaction.isChatInputCommand();
    await interaction
      .reply({
        ...(isEphemeralFallback ? { flags: MessageFlags.Ephemeral } : {}),
        embeds: [errorEmbed],
      })
      .catch(() => undefined);
  }
}

/**
 * Schedules or refreshes the periodic SQLite online backup interval.
 *
 * @param databaseClient the active SQLite database client
 * @param config the active application configuration
 * @param previousTimer existing backup interval handle to clear
 * @returns the new interval handle or null if backups are disabled
 */
function scheduleBackupTask(
  databaseClient: DatabaseClient,
  config: AppConfig,
  previousTimer: NodeJS.Timeout | null,
): NodeJS.Timeout | null {
  if (previousTimer !== null) {
    clearInterval(previousTimer);
  }
  if (!config.database.backup.enabled) {
    return null;
  }

  const intervalMs = config.database.backup.intervalMinutes * 60 * 1000;
  const timer = setInterval(() => {
    try {
      const backupPath = databaseClient.createBackup(
        config.database.backup.directory,
        config.database.backup.maxFiles,
        config.bot.clubCohortPrefix,
      );
      Logger.info("AutoBackup", `Created SQLite backup at ${backupPath}`);
    } catch (error) {
      Logger.error("AutoBackup", "Scheduled SQLite backup failed", error);
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

/**
 * Validates and applies an updated config.yaml at runtime, rejecting SQLite path changes.
 *
 * @param context the shared runtime container
 * @param guild the active Discord guild
 * @returns a structured ReloadOutcome describing success or rejection reason
 */
function applyRuntimeConfigReload(
  context: RuntimeContext,
  guild: Guild,
): ReloadOutcome {
  let candidateConfig: AppConfig;
  try {
    candidateConfig = ConfigLoader.loadAppConfig(
      context.environment.CONFIG_PATH,
    );
  } catch (error) {
    return {
      success: false,
      title: "Config Reload Failed",
      description: `Kept previous running configuration.\n\n\`\`\`\n${error instanceof Error ? error.message : String(error)}\n\`\`\``,
    };
  }

  const previousDbPath = ConfigLoader.resolveDatabasePath(context.activeConfig);
  const nextDbPath = ConfigLoader.resolveDatabasePath(candidateConfig);
  if (previousDbPath !== nextDbPath) {
    return {
      success: false,
      title: "Config Reload Rejected",
      description: `Kept previous running configuration because the SQLite database path changed (\`${previousDbPath}\` -> \`${nextDbPath}\`). Restart the bot to switch SQLite files.`,
    };
  }

  const candidateResolver = new GuildResourceResolver(candidateConfig);
  const missingResources = candidateResolver.validateConfiguredResources(guild);
  if (missingResources.length > 0) {
    return {
      success: false,
      title: "Config Reload Failed",
      description: `Kept previous running configuration because configured Discord IDs were not found:\n${missingResources.map((item) => `• \`${item}\``).join("\n")}`,
    };
  }

  context.activeConfig = candidateConfig;
  context.resourceResolver.updateConfig(candidateConfig);
  context.verificationController.updateConfig(candidateConfig);
  context.studentController.updateConfig(candidateConfig);
  context.verifyView.updateConfig(candidateConfig);
  context.studentView.updateConfig(candidateConfig);
  context.systemView.updateConfig(candidateConfig);
  Logger.configure(candidateConfig.logging);
  context.backupTimer = scheduleBackupTask(
    context.databaseClient,
    candidateConfig,
    context.backupTimer,
  );

  return {
    success: true,
    title: "Configuration Reloaded",
    description: `Validated and applied \`${context.environment.CONFIG_PATH}\` with zero downtime.`,
  };
}

/**
 * Fetches guild caches, validates configured IDs, syncs SQLite state, and registers slash commands.
 *
 * @param readyClient the authenticated Discord client
 * @param context the shared runtime container
 */
async function initializeGuildSession(
  readyClient: Client<true>,
  context: RuntimeContext,
): Promise<void> {
  Logger.attachDiscordClient(readyClient);
  Logger.info("Bootstrap", `Logged in as ${readyClient.user.tag}.`);

  const guild = await readyClient.guilds
    .fetch(context.environment.DISCORD_SERVER_ID)
    .catch(() => null);
  if (!guild) {
    Logger.error(
      "Bootstrap",
      `Configured DISCORD_SERVER_ID (${context.environment.DISCORD_SERVER_ID}) was not found.`,
    );
    await Logger.shutdown();
    await readyClient.destroy();
    context.databaseClient.close();
    process.exit(1);
  }

  await Promise.all([
    guild.roles.fetch(),
    guild.channels.fetch(),
    guild.members.fetch().catch((error: unknown) => {
      Logger.warn(
        "Bootstrap",
        `Failed prefetching guild members: ${String(error)}`,
      );
    }),
  ]);

  const missingResources =
    context.resourceResolver.validateConfiguredResources(guild);
  if (missingResources.length > 0) {
    Logger.error(
      "Bootstrap",
      `Configured Discord IDs missing in guild "${guild.name}":\n${missingResources.map((item) => `  - ${item}`).join("\n")}`,
    );
    await Logger.shutdown();
    await readyClient.destroy();
    context.databaseClient.close();
    process.exit(1);
  }

  Logger.info(
    "Bootstrap",
    `Cached ${String(guild.members.cache.size)} members for ${guild.name}.`,
  );
  const syncResult =
    await context.studentController.syncStudentsToDiscord(guild);
  Logger.info("Bootstrap", "Reconciled SQLite student records with Discord", {
    updatedCount: syncResult.updatedCount,
    skippedCount: syncResult.skippedCount,
    failedCount: syncResult.failedMembers.length,
  });

  context.backupTimer = scheduleBackupTask(
    context.databaseClient,
    context.activeConfig,
    context.backupTimer,
  );

  await registerGuildCommands(
    context.environment.DISCORD_APPLICATION_TOKEN,
    context.environment.DISCORD_APPLICATION_ID,
    context.environment.DISCORD_SERVER_ID,
    [
      context.verifyView.getCommandDefinition().toJSON(),
      context.studentView.getCommandDefinition().toJSON(),
      context.roundView.getCommandDefinition().toJSON(),
      context.systemView.getCommandDefinition().toJSON(),
    ],
  );
}

/**
 * Waits briefly for active in-flight member mutations to finish before shutting down.
 *
 * @param lockedDiscordIds shared Set tracking in-flight member operations
 */
async function waitForInFlightOperations(
  lockedDiscordIds: Set<string>,
): Promise<void> {
  const deadlineMs = Date.now() + SHUTDOWN_DRAIN_TIMEOUT_MS;
  while (lockedDiscordIds.size > 0 && Date.now() < deadlineMs) {
    await new Promise((resolve) =>
      setTimeout(resolve, SHUTDOWN_POLL_INTERVAL_MS),
    );
  }
}

/**
 * Creates an idempotent async shutdown handler for SIGINT and SIGTERM signals.
 *
 * @param client the Discord client instance
 * @param context the shared runtime container
 * @returns signal handler callback
 */
function createShutdownHandler(
  client: Client,
  context: RuntimeContext,
): (signal: string) => void {
  let isShuttingDown = false;

  return (signal: string): void => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    void (async (): Promise<void> => {
      Logger.info(
        "Shutdown",
        `Received ${signal}. Draining active tasks and closing resources.`,
      );
      if (context.backupTimer !== null) {
        clearInterval(context.backupTimer);
        context.backupTimer = null;
      }

      await waitForInFlightOperations(context.lockedDiscordIds);
      await Logger.shutdown();
      await client.destroy();
      context.databaseClient.close();
      process.exit(0);
    })();
  };
}

/**
 * Bootstraps configuration, SQLite repository, controllers, views, schedulers, and Discord Gateway.
 */
async function bootstrap(): Promise<void> {
  const environment = ConfigLoader.loadEnvironment();
  const activeConfig = ConfigLoader.loadAppConfig(environment.CONFIG_PATH);
  Logger.configure(activeConfig.logging);

  const activeDatabasePath = ConfigLoader.resolveDatabasePath(activeConfig);
  Logger.info("Bootstrap", `Using SQLite database at ${activeDatabasePath}`);
  const databaseClient = new DatabaseClient(activeDatabasePath);
  const studentRepository = new StudentRepository(databaseClient);
  studentRepository.seedVerificationGateDefault(
    activeConfig.verification.enabledByDefault,
  );

  const lockedDiscordIds = new Set<string>();
  const resourceResolver = new GuildResourceResolver(activeConfig);
  const verificationController = new VerificationController(
    activeConfig,
    studentRepository,
    resourceResolver,
    lockedDiscordIds,
  );
  const studentController = new StudentController(
    activeConfig,
    studentRepository,
    resourceResolver,
    lockedDiscordIds,
  );
  const roundController = new RoundController(
    studentRepository,
    resourceResolver,
    lockedDiscordIds,
  );

  const verifyView = new VerifyCommandView(
    activeConfig,
    verificationController,
  );
  const studentView = new StudentCommandView(
    activeConfig,
    studentController,
    resourceResolver,
  );
  const roundView = new RoundCommandView(roundController, resourceResolver);

  const context: RuntimeContext = {
    environment,
    activeConfig,
    databaseClient,
    lockedDiscordIds,
    resourceResolver,
    verificationController,
    studentController,
    verifyView,
    studentView,
    roundView,
    systemView: null as unknown as SystemCommandView,
    backupTimer: null,
  };

  context.systemView = new SystemCommandView(
    activeConfig,
    studentRepository,
    studentController,
    resourceResolver,
    (guild) => applyRuntimeConfigReload(context, guild),
  );

  const client = createDiscordClient();

  client.once(Events.ClientReady, (readyClient) => {
    void initializeGuildSession(readyClient, context).catch(
      async (error: unknown) => {
        Logger.error("Bootstrap", "Startup initialization failed", error);
        await Logger.shutdown();
        await client.destroy();
        databaseClient.close();
        process.exit(1);
      },
    );
  });

  client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    const resolvedMember: GuildMember = newMember;
    if (resolvedMember.guild.id !== environment.DISCORD_SERVER_ID) {
      return;
    }
    verificationController.syncMemberRolesToDatabase(oldMember, resolvedMember);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void dispatchInteraction(
      interaction,
      verifyView,
      studentView,
      roundView,
      context.systemView,
    );
  });

  const handleShutdown = createShutdownHandler(client, context);
  process.once("SIGINT", () => {
    handleShutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    handleShutdown("SIGTERM");
  });

  await client.login(environment.DISCORD_APPLICATION_TOKEN);
}

bootstrap().catch((error: unknown) => {
  Logger.error("Bootstrap", "Fatal startup failure", error);
  process.exit(1);
});
