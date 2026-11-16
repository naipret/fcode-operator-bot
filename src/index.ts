import { Events, type GuildMember, type Interaction, MessageFlags, REST, Routes } from 'discord.js';
import { createDiscordClient } from './client.js';
import { ConfigLoader } from './config/ConfigLoader.js';
import { RoundController } from './controller/RoundController.js';
import { StudentController } from './controller/StudentController.js';
import { VerificationController } from './controller/VerificationController.js';
import { DatabaseClient } from './repository/DatabaseClient.js';
import { StudentRepository } from './repository/StudentRepository.js';
import { GuildResourceResolver } from './util/GuildResourceResolver.js';
import { Logger } from './util/Logger.js';
import { EmbedFactory } from './view/EmbedFactory.js';
import { RoundCommandView } from './view/RoundCommandView.js';
import { StudentCommandView } from './view/StudentCommandView.js';
import { VerifyCommandView } from './view/VerifyCommandView.js';

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
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
    body: commandPayloads,
  });
  Logger.info('Bootstrap', `Registered ${commandPayloads.length} guild slash commands.`);
}

/**
 * Dispatches Discord interactions to the appropriate MVC view handler with safe error handling.
 *
 * @param interaction the incoming Discord interaction
 * @param verifyView the verification command view
 * @param studentView the student command view
 * @param roundView the round command view
 */
async function dispatchInteraction(
  interaction: Interaction,
  verifyView: VerifyCommandView,
  studentView: StudentCommandView,
  roundView: RoundCommandView,
): Promise<void> {
  try {
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'verify':
          await verifyView.handleSlashCommand(interaction);
          return;
        case 'student':
          await studentView.handleSlashCommand(interaction);
          return;
        case 'round':
          await roundView.handleSlashCommand(interaction);
          return;
      }
      return;
    }

    if (interaction.isButton()) {
      if (verifyView.ownsCustomId(interaction.customId)) {
        await verifyView.handleVerifyButton(interaction);
        return;
      }
      if (roundView.ownsCustomId(interaction.customId)) {
        await roundView.handleButton(interaction);
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      if (verifyView.ownsCustomId(interaction.customId)) {
        await verifyView.handleModalSubmit(interaction);
      }
      return;
    }

    if (interaction.isUserSelectMenu()) {
      if (roundView.ownsCustomId(interaction.customId)) {
        await roundView.handleUserSelectMenu(interaction);
      }
    }
  } catch (error) {
    Logger.error('InteractionDispatcher', 'Unhandled error while processing interaction', error);
    const errorEmbed = EmbedFactory.buildErrorEmbed(
      'Unexpected System Error',
      'An unexpected error occurred while processing your request. Please try again or contact a moderator.',
    );

    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction
          .editReply({ embeds: [errorEmbed], components: [] })
          .catch(() => undefined);
      } else {
        const isEphemeralFallback = !interaction.isChatInputCommand();
        await interaction
          .reply({
            ...(isEphemeralFallback ? { flags: MessageFlags.Ephemeral } : {}),
            embeds: [errorEmbed],
          })
          .catch(() => undefined);
      }
    }
  }
}

/**
 * Bootstraps configuration, SQLite repository, controllers, views, and Discord Gateway connection.
 */
async function bootstrap(): Promise<void> {
  const environment = ConfigLoader.loadEnvironment();
  const appConfig = ConfigLoader.loadAppConfig(environment.CONFIG_PATH);
  Logger.configure(appConfig.logging);

  const databasePath = ConfigLoader.resolveDatabasePath(appConfig);
  Logger.info('Bootstrap', `Using SQLite database at ${databasePath}`);
  const databaseClient = new DatabaseClient(databasePath);
  const studentRepository = new StudentRepository(databaseClient);
  studentRepository.seedVerificationGateDefault(appConfig.verification.enabledByDefault);

  const resourceResolver = new GuildResourceResolver(appConfig);
  const verificationController = new VerificationController(
    appConfig,
    studentRepository,
    resourceResolver,
  );
  const studentController = new StudentController(appConfig, studentRepository, resourceResolver);
  const roundController = new RoundController(studentRepository, resourceResolver);

  const verifyView = new VerifyCommandView(
    appConfig,
    studentRepository,
    verificationController,
    resourceResolver,
  );
  const studentView = new StudentCommandView(studentController, resourceResolver);
  const roundView = new RoundCommandView(appConfig, roundController, resourceResolver);

  const client = createDiscordClient();

  client.once(Events.ClientReady, (readyClient) => {
    void (async () => {
      Logger.info('Bootstrap', `Logged in as ${readyClient.user.tag}.`);

      const guild = await readyClient.guilds.fetch(environment.DISCORD_SERVER_ID).catch(() => null);
      if (!guild) {
        Logger.error(
          'Bootstrap',
          `Configured DISCORD_SERVER_ID (${environment.DISCORD_SERVER_ID}) was not found.`,
        );
        await client.destroy();
        databaseClient.close();
        process.exit(1);
      }

      await Promise.all([
        guild.roles.fetch(),
        guild.channels.fetch(),
        guild.members.fetch().catch((error) => {
          Logger.warn('Bootstrap', `Failed prefetching guild members: ${String(error)}`);
        }),
      ]);

      const missingResources = resourceResolver.validateConfiguredResources(guild);
      if (missingResources.length > 0) {
        Logger.error(
          'Bootstrap',
          `Configured Discord IDs missing in guild "${guild.name}":\n${missingResources.map((item) => `  - ${item}`).join('\n')}`,
        );
        await client.destroy();
        databaseClient.close();
        process.exit(1);
      }

      Logger.info('Bootstrap', `Cached ${guild.members.cache.size} members for ${guild.name}.`);

      const syncResult = await studentController.syncStudentsToDiscord(guild);
      Logger.info('Bootstrap', 'Reconciled SQLite student records with Discord', {
        updatedCount: syncResult.updatedCount,
        skippedCount: syncResult.skippedCount,
        failedCount: syncResult.failedMembers.length,
      });

      await registerGuildCommands(
        environment.DISCORD_APPLICATION_TOKEN,
        environment.DISCORD_APPLICATION_ID,
        environment.DISCORD_SERVER_ID,
        [
          verifyView.getCommandDefinition().toJSON(),
          studentView.getCommandDefinition().toJSON(),
          roundView.getCommandDefinition().toJSON(),
        ],
      );
    })().catch((error) => {
      Logger.error('Bootstrap', 'Startup initialization failed', error);
      void client.destroy();
      databaseClient.close();
      process.exit(1);
    });
  });

  client.on(Events.GuildMemberUpdate, (_oldMember, newMember) => {
    const resolvedMember: GuildMember = newMember;
    if (resolvedMember.guild.id !== environment.DISCORD_SERVER_ID) {
      return;
    }
    verificationController.syncMemberRolesToDatabase(resolvedMember);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void dispatchInteraction(interaction, verifyView, studentView, roundView);
  });

  const shutdown = (signal: string): void => {
    Logger.info('Shutdown', `Received ${signal}. Closing Discord client and SQLite connection.`);
    void client.destroy();
    databaseClient.close();
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await client.login(environment.DISCORD_APPLICATION_TOKEN);
}

bootstrap().catch((error) => {
  Logger.error('Bootstrap', 'Fatal startup failure', error);
  process.exit(1);
});
