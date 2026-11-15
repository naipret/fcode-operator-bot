import {
  ActionRowBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { AppConfig } from '../config/ConfigSchema.js';
import type { VerificationController } from '../controller/VerificationController.js';
import type { VerificationOutcome } from '../model/Student.js';
import type { StudentRepository } from '../repository/StudentRepository.js';
import type { GuildResourceResolver } from '../util/GuildResourceResolver.js';
import { InputValidator } from '../util/InputValidator.js';
import { EmbedFactory } from './EmbedFactory.js';

/**
 * Custom identifier shared between the persistent panel button and runtime handler.
 */
export const VERIFY_PANEL_BUTTON_ID = 'fcode-verify-open-button';

/**
 * Custom identifier for the modal opened from the public /verify slash command.
 */
const VERIFY_SLASH_MODAL_ID = 'fcode-verify-slash-modal';

/**
 * Custom identifier for the modal opened from the ephemeral [Verify Account] button.
 */
const VERIFY_BUTTON_MODAL_ID = 'fcode-verify-button-modal';

/**
 * Presents the /verify command, persistent button handler, and 1-step verification modal.
 */
export class VerifyCommandView {
  private readonly appConfig: AppConfig;
  private readonly studentRepository: StudentRepository;
  private readonly verificationController: VerificationController;
  private readonly resourceResolver: GuildResourceResolver;

  /**
   * Creates a VerifyCommandView bound to controller, repository, and config.
   *
   * @param appConfig the validated application configuration
   * @param studentRepository the SQLite student repository
   * @param verificationController the verification business controller
   * @param resourceResolver the guild resource resolver
   */
  public constructor(
    appConfig: AppConfig,
    studentRepository: StudentRepository,
    verificationController: VerificationController,
    resourceResolver: GuildResourceResolver,
  ) {
    this.appConfig = appConfig;
    this.studentRepository = studentRepository;
    this.verificationController = verificationController;
    this.resourceResolver = resourceResolver;
  }

  /**
   * Builds the slash command metadata registered with Discord.
   *
   * @returns a SlashCommandBuilder defining /verify and its optional inline fields
   */
  public getCommandDefinition(): SlashCommandBuilder {
    return new SlashCommandBuilder()
      .setName('verify')
      .setDescription('Verify your student identity and unlock Challenge 1.')
      .addStringOption((option) =>
        option
          .setName('full-name')
          .setDescription('Your full name (for example, Nguyen Van A).')
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('student-id')
          .setDescription('Your FPT University student ID (for example, SE220001).')
          .setRequired(false),
      ) as SlashCommandBuilder;
  }

  /**
   * Handles incoming /verify slash command invocations with public channel responses.
   *
   * @param interaction the slash command interaction
   */
  public async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.member) {
      await interaction.reply({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            'Server Required',
            'This command can only be executed inside a Discord server.',
          ),
        ],
      });
      return;
    }

    const rawFullName = interaction.options.getString('full-name');
    const rawStudentId = interaction.options.getString('student-id');
    const providedCount = [rawFullName, rawStudentId].filter((value) => value !== null).length;

    const member = await interaction.guild.members.fetch(interaction.user.id);

    if (providedCount === 0) {
      await this.startInteractiveVerification(interaction, member, false);
      return;
    }

    if (providedCount < 2 || !rawFullName || !rawStudentId) {
      await interaction.reply({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            'Incomplete Parameters',
            'Provide both `full-name` and `student-id` together, or invoke `/verify` with no options to open the verification form.',
          ),
        ],
      });
      return;
    }

    await interaction.deferReply();
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
  public async handleVerifyButton(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.guild) {
      return;
    }
    const member = await interaction.guild.members.fetch(interaction.user.id);
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
  public async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.guild) {
      return;
    }
    const isEphemeral = interaction.customId === VERIFY_BUTTON_MODAL_ID;
    if (!isEphemeral && interaction.customId !== VERIFY_SLASH_MODAL_ID) {
      return;
    }

    await interaction.deferReply(isEphemeral ? { flags: MessageFlags.Ephemeral } : undefined);

    const rawFullName = interaction.fields.getTextInputValue('full-name-input');
    const rawStudentId = interaction.fields.getTextInputValue('student-id-input');
    const member = await interaction.guild.members.fetch(interaction.user.id);

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
    const existingRecord = this.studentRepository.findByDiscordId(member.id);
    if (existingRecord?.isVerified) {
      await interaction.deferReply(isEphemeral ? { flags: MessageFlags.Ephemeral } : undefined);
      const outcome = await this.verificationController.checkAndRestoreIfVerified(member);
      if (outcome) {
        await interaction.editReply({
          embeds: [this.mapOutcomeToEmbed(outcome)],
        });
        return;
      }
    }

    if (!this.verificationController.isVerificationGateEnabled()) {
      const supportMention = this.resourceResolver.getSupportChannelMention();
      const warningEmbed = EmbedFactory.buildWarningEmbed(
        'Verification Closed',
        `${this.appConfig.messages.verificationClosedMessage} Support channel: ${supportMention}.`,
      );
      if (isEphemeral) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [warningEmbed] });
      } else {
        await interaction.reply({ embeds: [warningEmbed] });
      }
      return;
    }

    const modalId = isEphemeral ? VERIFY_BUTTON_MODAL_ID : VERIFY_SLASH_MODAL_ID;
    await interaction.showModal(this.buildVerificationModal(modalId));
  }

  /**
   * Constructs the Discord Modal requesting full name and student identifier.
   *
   * @param customId the modal identifier indicating public slash or ephemeral button origin
   * @returns a ModalBuilder instance
   */
  private buildVerificationModal(customId: string): ModalBuilder {
    const fullNameInput = new TextInputBuilder()
      .setCustomId('full-name-input')
      .setLabel('Full Name')
      .setPlaceholder('Example: Nguyen Van A')
      .setStyle(TextInputStyle.Short)
      .setMinLength(2)
      .setMaxLength(60)
      .setRequired(true);

    const studentIdLabel = InputValidator.interpolateConfigText(
      'Student ID (Cohorts {cohorts})',
      this.appConfig.bot,
    );

    const studentIdInput = new TextInputBuilder()
      .setCustomId('student-id-input')
      .setLabel(studentIdLabel)
      .setPlaceholder('Example: SE220001')
      .setStyle(TextInputStyle.Short)
      .setMinLength(8)
      .setMaxLength(12)
      .setRequired(true);

    return new ModalBuilder()
      .setCustomId(customId)
      .setTitle('Student Verification')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(fullNameInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(studentIdInput),
      );
  }

  /**
   * Maps a VerificationOutcome into an appropriately colored Discord Embed.
   *
   * @param outcome the controller outcome
   * @returns a Discord EmbedBuilder
   */
  private mapOutcomeToEmbed(outcome: VerificationOutcome) {
    const fullDescription = outcome.nicknameHierarchyWarning
      ? `${outcome.description}\n\nHierarchy Notice: ${outcome.nicknameHierarchyWarning}`
      : outcome.description;

    switch (outcome.status) {
      case 'VERIFIED':
      case 'RESTORED':
        return outcome.nicknameHierarchyWarning
          ? EmbedFactory.buildWarningEmbed(outcome.title, fullDescription)
          : EmbedFactory.buildSuccessEmbed(outcome.title, fullDescription);
      case 'ALREADY_ACTIVE':
        return EmbedFactory.buildInfoEmbed(outcome.title, fullDescription);
      case 'GATE_CLOSED':
      case 'LOCKED':
        return EmbedFactory.buildWarningEmbed(outcome.title, fullDescription);
      case 'INVALID_INPUT':
      case 'NICKNAME_TOO_LONG':
      case 'CONFLICT':
        return EmbedFactory.buildErrorEmbed(outcome.title, fullDescription);
    }
  }
}
