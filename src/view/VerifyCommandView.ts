import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  type GuildMember,
  MessageFlags,
  type ModalSubmitInteraction,
  SlashCommandBuilder,
} from "discord.js";
import type { AppConfig } from "../config/ConfigSchema.js";
import type { VerificationController } from "../controller/VerificationController.js";
import type { VerificationOutcome } from "../model/Student.js";
import { EmbedFactory } from "./EmbedFactory.js";
import {
  buildStudentInputModal,
  resolveInteractionMember,
} from "./StudentModalBuilder.js";

/**
 * Custom identifier shared between the persistent panel button and runtime handler.
 */
export const VERIFY_PANEL_BUTTON_ID = "fcode-verify-open-button";

/**
 * Custom identifier for the modal opened from the public /verify slash command.
 */
const VERIFY_SLASH_MODAL_ID = "fcode-verify-slash-modal";

/**
 * Custom identifier for the modal opened from the ephemeral [Verify Account] button.
 */
const VERIFY_BUTTON_MODAL_ID = "fcode-verify-button-modal";

/**
 * Presents the /verify command, persistent button handler, and 1-step verification modal.
 */
export class VerifyCommandView {
  private appConfig: AppConfig;
  private readonly verificationController: VerificationController;

  /**
   * Creates a VerifyCommandView bound to controller and config.
   *
   * @param appConfig the validated application configuration
   * @param verificationController the verification business controller
   */
  public constructor(
    appConfig: AppConfig,
    verificationController: VerificationController,
  ) {
    this.appConfig = appConfig;
    this.verificationController = verificationController;
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
   * Builds the slash command metadata registered with Discord.
   *
   * @returns a SlashCommandBuilder defining /verify and its optional inline fields
   */
  public getCommandDefinition(): SlashCommandBuilder {
    const latestCohort = this.appConfig.bot.allowedCohorts.at(-1) ?? "22";
    return new SlashCommandBuilder()
      .setName("verify")
      .setDescription("Verify your student identity.")
      .addStringOption((option) =>
        option
          .setName("full-name")
          .setDescription("Your full name (for example, Nguyễn Văn A).")
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName("student-id")
          .setDescription(
            `Your FPT University student ID (for example, SE${latestCohort}0001).`,
          )
          .setRequired(false),
      ) as SlashCommandBuilder;
  }

  /**
   * Handles incoming /verify slash command invocations with public channel responses.
   *
   * @param interaction the slash command interaction
   */
  public async handleSlashCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (!interaction.guild || !interaction.member) {
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

    const rawFullName = interaction.options.getString("full-name");
    const rawStudentId = interaction.options.getString("student-id");
    const providedCount = [rawFullName, rawStudentId].filter(
      (value) => value !== null,
    ).length;

    if (providedCount === 0) {
      const member = await resolveInteractionMember(
        interaction.guild,
        interaction.member,
        interaction.user.id,
      );
      await this.startInteractiveVerification(interaction, member, false);
      return;
    }

    if (providedCount < 2 || !rawFullName || !rawStudentId) {
      await interaction.reply({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            "Incomplete Parameters",
            "Provide both `full-name` and `student-id` together, or invoke `/verify` with no options to open the verification form.",
          ),
        ],
      });
      return;
    }

    await interaction.deferReply();
    const member = await resolveInteractionMember(
      interaction.guild,
      interaction.member,
      interaction.user.id,
    );
    const outcome = await this.verificationController.registerNewStudent(
      member,
      rawFullName,
      rawStudentId,
    );
    await interaction.editReply({ embeds: [this.mapOutcomeToEmbed(outcome)] });
  }

  /**
   * Handles clicks on the persistent verification panel button with ephemeral responses.
   *
   * @param interaction the Discord button interaction
   */
  public async handleVerifyButton(
    interaction: ButtonInteraction,
  ): Promise<void> {
    if (!interaction.guild) {
      return;
    }
    const member = await resolveInteractionMember(
      interaction.guild,
      interaction.member,
      interaction.user.id,
    );
    await this.startInteractiveVerification(interaction, member, true);
  }

  /**
   * Checks whether a customId belongs to this view's button or verification modals.
   *
   * @param customId the component or modal custom identifier
   * @returns true if handled by VerifyCommandView
   */
  public ownsCustomId(customId: string): boolean {
    return (
      customId === VERIFY_PANEL_BUTTON_ID ||
      customId === VERIFY_SLASH_MODAL_ID ||
      customId === VERIFY_BUTTON_MODAL_ID
    );
  }

  /**
   * Completes 1-step student verification when the verification modal is submitted.
   *
   * @param interaction the modal submit interaction
   */
  public async handleModalSubmit(
    interaction: ModalSubmitInteraction,
  ): Promise<void> {
    if (!interaction.guild) {
      return;
    }
    const isEphemeral = interaction.customId === VERIFY_BUTTON_MODAL_ID;
    if (!isEphemeral && interaction.customId !== VERIFY_SLASH_MODAL_ID) {
      return;
    }

    await interaction.deferReply(
      isEphemeral ? { flags: MessageFlags.Ephemeral } : undefined,
    );

    const rawFullName = interaction.fields.getTextInputValue("full-name-input");
    const rawStudentId =
      interaction.fields.getTextInputValue("student-id-input");
    const member = await resolveInteractionMember(
      interaction.guild,
      interaction.member,
      interaction.user.id,
    );

    const outcome = await this.verificationController.registerNewStudent(
      member,
      rawFullName,
      rawStudentId,
    );
    await interaction.editReply({ embeds: [this.mapOutcomeToEmbed(outcome)] });
  }

  /**
   * Routes slash or button verification calls to instant restoration or the registration modal.
   *
   * @param interaction the slash command or button interaction
   * @param member the resolved Discord guild member
   * @param isEphemeral whether responses should be ephemeral (true for button, false for slash)
   */
  private async startInteractiveVerification(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
    member: GuildMember,
    isEphemeral: boolean,
  ): Promise<void> {
    if (this.verificationController.hasRestorableRecord(member)) {
      await interaction.deferReply(
        isEphemeral ? { flags: MessageFlags.Ephemeral } : undefined,
      );
      const outcome =
        await this.verificationController.checkAndRestoreIfVerified(member);
      if (outcome) {
        await interaction.editReply({
          embeds: [this.mapOutcomeToEmbed(outcome)],
        });
        return;
      }
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildWarningEmbed(
            "Verification Status Changed",
            "Your account state changed while checking your record. Please run verification again.",
          ),
        ],
      });
      return;
    }

    if (!this.verificationController.isVerificationGateEnabled()) {
      const warningEmbed = EmbedFactory.buildWarningEmbed(
        "Verification Closed",
        this.appConfig.messages.verificationClosedMessage,
      );
      if (isEphemeral) {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          embeds: [warningEmbed],
        });
      } else {
        await interaction.reply({ embeds: [warningEmbed] });
      }
      return;
    }

    const latestCohort = this.appConfig.bot.allowedCohorts.at(-1) ?? "22";
    const modalId = isEphemeral
      ? VERIFY_BUTTON_MODAL_ID
      : VERIFY_SLASH_MODAL_ID;
    await interaction.showModal(
      buildStudentInputModal(modalId, "Student Verification", latestCohort),
    );
  }

  /**
   * Maps a VerificationOutcome into an appropriately colored Discord Embed.
   *
   * @param outcome the controller outcome
   * @returns a Discord EmbedBuilder
   */
  private mapOutcomeToEmbed(outcome: VerificationOutcome): EmbedBuilder {
    const fullDescription = outcome.nicknameHierarchyWarning
      ? `${outcome.description}\n\nHierarchy Notice: ${outcome.nicknameHierarchyWarning}`
      : outcome.description;

    switch (outcome.status) {
      case "VERIFIED":
      case "RESTORED":
        return outcome.nicknameHierarchyWarning
          ? EmbedFactory.buildWarningEmbed(outcome.title, fullDescription)
          : EmbedFactory.buildSuccessEmbed(outcome.title, fullDescription);
      case "ALREADY_ACTIVE":
        return EmbedFactory.buildInfoEmbed(outcome.title, fullDescription);
      case "GATE_CLOSED":
      case "LOCKED":
        return EmbedFactory.buildWarningEmbed(outcome.title, fullDescription);
      case "INVALID_INPUT":
      case "NICKNAME_TOO_LONG":
      case "CONFLICT":
        return EmbedFactory.buildErrorEmbed(outcome.title, fullDescription);
    }
  }
}
