import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type ChatInputCommandInteraction,
  type Guild,
  SlashCommandBuilder,
} from "discord.js";
import type { AppConfig } from "../config/ConfigSchema.js";
import type { StudentController } from "../controller/StudentController.js";
import type { StudentRepository } from "../repository/StudentRepository.js";
import type { GuildResourceResolver } from "../util/GuildResourceResolver.js";
import { InputValidator } from "../util/InputValidator.js";
import { Logger } from "../util/Logger.js";
import { EmbedFactory } from "./EmbedFactory.js";
import { resolveInteractionMember } from "./StudentModalBuilder.js";
import { VERIFY_PANEL_BUTTON_ID } from "./VerifyCommandView.js";

/**
 * Outcome returned by transactional config hot-reload callbacks.
 */
export interface ReloadOutcome {
  success: boolean;
  title: string;
  description: string;
}

/**
 * Presents the owner-only /system slash commands (verify gate + panel, sync, and reload).
 */
export class SystemCommandView {
  private appConfig: AppConfig;
  private readonly studentRepository: StudentRepository;
  private readonly studentController: StudentController;
  private readonly resourceResolver: GuildResourceResolver;
  private readonly onReload: (guild: Guild) => ReloadOutcome;

  /**
   * Creates a SystemCommandView bound to config, repository, controller, resolver, and reload hook.
   *
   * @param appConfig the validated application configuration
   * @param studentRepository the SQLite student repository
   * @param studentController the student controller for DB-to-Discord sync
   * @param resourceResolver the guild resource resolver
   * @param onReload callback performing transactional config hot-reload
   */
  public constructor(
    appConfig: AppConfig,
    studentRepository: StudentRepository,
    studentController: StudentController,
    resourceResolver: GuildResourceResolver,
    onReload: (guild: Guild) => ReloadOutcome,
  ) {
    this.appConfig = appConfig;
    this.studentRepository = studentRepository;
    this.studentController = studentController;
    this.resourceResolver = resourceResolver;
    this.onReload = onReload;
  }

  /**
   * Replaces the active configuration reference during a hot-reload.
   *
   * @param newConfig the newly validated application configuration
   */
  public updateConfig(newConfig: AppConfig): void {
    this.appConfig = newConfig;
  }

  /**
   * Builds the /system slash command definition with verify, sync, and reload subcommands.
   *
   * @returns a SlashCommandBuilder defining /system
   */
  public getCommandDefinition(): SlashCommandBuilder {
    return new SlashCommandBuilder()
      .setName("system")
      .setDescription(
        "Manage bot verification gate, database sync, and configuration (owner only).",
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("verify")
          .setDescription(
            "Enable/disable verification and optionally post or update the panel.",
          )
          .addBooleanOption((option) =>
            option
              .setName("enabled")
              .setDescription(
                "Set to true to allow new verifications, or false to close.",
              )
              .setRequired(true),
          )
          .addChannelOption((option) =>
            option
              .setName("panel-channel")
              .setDescription(
                "Optional text channel to post or update the verification panel.",
              )
              .addChannelTypes(ChannelType.GuildText)
              .setRequired(false),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("sync")
          .setDescription(
            "Synchronize SQLite student records (nicknames and roles) to Discord.",
          )
          .addStringOption((option) =>
            option
              .setName("target")
              .setDescription(
                "Optional @user or Student ID (omit to sync all active student and staff records).",
              )
              .setRequired(false),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("staff")
          .setDescription(
            "Promote a verified member to moderator or supporter, or reset staff roles.",
          )
          .addUserOption((option) =>
            option
              .setName("user")
              .setDescription("Target Discord member.")
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("role")
              .setDescription(
                "Staff role to assign, or reset to clear all roles and DB record.",
              )
              .setRequired(true)
              .addChoices(
                { name: "moderator", value: "moderator" },
                { name: "supporter", value: "supporter" },
                { name: "reset", value: "reset" },
              ),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("reload")
          .setDescription(
            "Validate and hot-reload config.yaml without restarting the bot.",
          ),
      ) as SlashCommandBuilder;
  }

  /**
   * Handles incoming /system slash command invocations after enforcing owner-only authorization.
   *
   * @param interaction the slash command interaction
   */
  public async handleSlashCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (!interaction.guild) {
      await interaction.reply({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            "Server Required",
            "This command can only be executed inside a Discord server.",
          ),
        ],
      });
      return;
    }

    await interaction.deferReply();
    const callerMember = await resolveInteractionMember(
      interaction.guild,
      interaction.member,
      interaction.user.id,
    );
    if (
      !this.resourceResolver.isOwnerOrHasOwnerRole(
        interaction.guild,
        callerMember,
      )
    ) {
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            "Owner Authorization Required",
            "Only the Server Owner or holders of the configured owner role can execute `/system` commands.",
          ),
        ],
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "verify") {
      await this.handleVerifySubcommand(interaction);
      return;
    }

    if (subcommand === "sync") {
      const target = interaction.options.getString("target");
      const outcome = await this.studentController.syncStudentsToDiscord(
        interaction.guild,
        target,
      );
      if (outcome.success) {
        Logger.info("SystemCommandView", "Executed manual DB-to-Discord sync", {
          callerId: interaction.user.id,
          target: target ?? "ALL",
          updatedCount: outcome.updatedCount,
          skippedCount: outcome.skippedCount,
          failedCount: outcome.failedMembers.length,
        });
      }
      await interaction.editReply({
        embeds: [
          outcome.success
            ? EmbedFactory.buildSuccessEmbed(outcome.title, outcome.description)
            : EmbedFactory.buildErrorEmbed(outcome.title, outcome.description),
        ],
      });
      return;
    }

    if (subcommand === "staff") {
      await this.handleStaffSubcommand(interaction);
      return;
    }

    if (subcommand === "reload") {
      const outcome = this.onReload(interaction.guild);
      if (outcome.success) {
        Logger.info("SystemCommandView", "Hot-reloaded config.yaml", {
          callerId: interaction.user.id,
        });
      } else {
        Logger.warn(
          "SystemCommandView",
          "Rejected invalid config.yaml during hot-reload",
          {
            callerId: interaction.user.id,
          },
        );
      }
      await interaction.editReply({
        embeds: [
          outcome.success
            ? EmbedFactory.buildSuccessEmbed(outcome.title, outcome.description)
            : EmbedFactory.buildErrorEmbed(outcome.title, outcome.description),
        ],
      });
    }
  }

  /**
   * Updates the verification gate and optionally posts or updates the panel in panel-channel.
   *
   * @param interaction the slash command interaction
   */
  private async handleVerifySubcommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const enabled = interaction.options.getBoolean("enabled", true);
    const panelChannel =
      interaction.options.getChannel<ChannelType.GuildText>("panel-channel");

    this.studentRepository.setVerificationEnabled(enabled);

    let panelNote = "";
    if (panelChannel) {
      const description = InputValidator.interpolateConfigText(
        this.appConfig.messages.verificationPanelDescription,
        this.appConfig.bot,
      );
      const panelEmbed = EmbedFactory.buildInfoEmbed(
        this.appConfig.messages.verificationPanelTitle,
        description,
      );
      const panelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(VERIFY_PANEL_BUTTON_ID)
          .setLabel(this.appConfig.messages.verificationPanelButtonLabel)
          .setStyle(ButtonStyle.Primary),
      );

      const recentMessages = await panelChannel.messages.fetch({ limit: 20 });
      const existingPanel = recentMessages.find(
        (message) =>
          message.author.id === interaction.client.user.id &&
          message.components.length > 0,
      );

      if (existingPanel) {
        await existingPanel.edit({
          embeds: [panelEmbed],
          components: [panelRow],
        });
        panelNote = `\nVerification panel updated in <#${panelChannel.id}>.`;
      } else {
        await panelChannel.send({
          embeds: [panelEmbed],
          components: [panelRow],
        });
        panelNote = `\nVerification panel posted in <#${panelChannel.id}>.`;
      }
    }

    Logger.info(
      "SystemCommandView",
      "Updated verification gate configuration",
      {
        callerId: interaction.user.id,
        enabled,
        panelChannelId: panelChannel?.id ?? null,
      },
    );

    await interaction.editReply({
      embeds: [
        EmbedFactory.buildSuccessEmbed(
          "Verification Gate Updated",
          `Candidate verification is now \`${enabled ? "OPEN" : "CLOSED"}\`.${panelNote}`,
        ),
      ],
    });
  }

  /**
   * Executes /system staff to promote, switch, or reset a member's staff role and nickname.
   *
   * @param interaction the deferred slash command interaction
   */
  private async handleStaffSubcommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (!interaction.guild) {
      return;
    }

    const targetUser = interaction.options.getUser("user", true);
    const targetRole = interaction.options.getString("role", true) as
      "moderator" | "supporter" | "reset";

    const targetMember = await interaction.guild.members
      .fetch(targetUser.id)
      .catch(() => null);
    if (!targetMember) {
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            "Invalid Target",
            "The target Discord member could not be found in this server.",
          ),
        ],
      });
      return;
    }

    const outcome = await this.studentController.manageStaffRole(
      targetMember,
      targetRole,
    );
    if (outcome.success) {
      Logger.info("SystemCommandView", "Updated member staff role", {
        callerId: interaction.user.id,
        targetId: targetMember.id,
        role: targetRole,
      });
    }

    await interaction.editReply({
      embeds: [
        outcome.success
          ? EmbedFactory.buildSuccessEmbed(outcome.title, outcome.description)
          : EmbedFactory.buildErrorEmbed(outcome.title, outcome.description),
      ],
    });
  }
}
