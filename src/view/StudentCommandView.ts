import {
  ActionRowBuilder,
  type ChatInputCommandInteraction,
  ModalBuilder,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { AppConfig } from '../config/ConfigSchema.js';
import type { StudentController } from '../controller/StudentController.js';
import type { GuildResourceResolver } from '../util/GuildResourceResolver.js';
import { Logger } from '../util/Logger.js';
import { EmbedFactory } from './EmbedFactory.js';

/**
 * Custom identifier prefix for the modal opened by /student register when fields are omitted.
 */
const STUDENT_REGISTER_MODAL_PREFIX = 'fcode-student-register-modal:';

/**
 * Presents the /student slash command group for moderators and the server owner.
 */
export class StudentCommandView {
  private appConfig: AppConfig;
  private readonly studentController: StudentController;
  private readonly resourceResolver: GuildResourceResolver;

  /**
   * Creates a StudentCommandView bound to AppConfig, StudentController, and GuildResourceResolver.
   *
   * @param appConfig the validated application configuration
   * @param studentController the student management controller
   * @param resourceResolver the guild resource resolver
   */
  public constructor(
    appConfig: AppConfig,
    studentController: StudentController,
    resourceResolver: GuildResourceResolver,
  ) {
    this.appConfig = appConfig;
    this.studentController = studentController;
    this.resourceResolver = resourceResolver;
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
   * Checks whether a modal customId belongs to StudentCommandView.
   *
   * @param customId the modal custom identifier
   * @returns true if handled by StudentCommandView
   */
  public ownsCustomId(customId: string): boolean {
    return customId.startsWith(STUDENT_REGISTER_MODAL_PREFIX);
  }

  /**
   * Builds the /student slash command and its lookup, register, and reset subcommands.
   *
   * @returns a SlashCommandBuilder defining /student
   */
  public getCommandDefinition(): SlashCommandBuilder {
    return new SlashCommandBuilder()
      .setName('student')
      .setDescription('Manage verified student records (moderator and owner only).')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addSubcommand((subcommand) =>
        subcommand
          .setName('lookup')
          .setDescription('Look up a student record by @user or Student ID.')
          .addStringOption((option) =>
            option
              .setName('target')
              .setDescription('@mention, Discord ID, or Student ID (for example, SE220001).')
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('register')
          .setDescription('Manually register or update a student record for support resolution.')
          .addUserOption((option) =>
            option.setName('user').setDescription('Target Discord user.').setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName('full-name')
              .setDescription('Approved full name or shortened name fitting within 32 characters.')
              .setRequired(false),
          )
          .addStringOption((option) =>
            option
              .setName('student-id')
              .setDescription('Student ID (for example, SE220001).')
              .setRequired(false),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('reset')
          .setDescription('Remove a student database record and clear their recruitment roles.')
          .addStringOption((option) =>
            option
              .setName('target')
              .setDescription('@mention, Discord ID, or Student ID to reset.')
              .setRequired(true),
          ),
      ) as SlashCommandBuilder;
  }

  /**
   * Handles incoming /student command interactions after verifying moderator authorization.
   *
   * @param interaction the slash command interaction
   */
  public async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
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

    const callerMember = await interaction.guild.members.fetch(interaction.user.id);
    if (!this.resourceResolver.isModeratorOrOwner(interaction.guild, callerMember)) {
      await interaction.reply({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            'Permission Denied',
            'Only the Server Owner or moderators can execute `/student` commands.',
          ),
        ],
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'register') {
      const targetUser = interaction.options.getUser('user', true);
      const rawFullName = interaction.options.getString('full-name');
      const rawStudentId = interaction.options.getString('student-id');
      const providedCount = [rawFullName, rawStudentId].filter((value) => value !== null).length;

      if (providedCount === 0) {
        await interaction.showModal(this.buildRegisterModal(targetUser.id));
        return;
      }

      if (providedCount < 2 || !rawFullName || !rawStudentId) {
        await interaction.reply({
          embeds: [
            EmbedFactory.buildErrorEmbed(
              'Incomplete Parameters',
              'Provide both `full-name` and `student-id` together, or omit both to open the registration form.',
            ),
          ],
        });
        return;
      }

      await interaction.deferReply();
      const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
      if (!targetMember) {
        await interaction.editReply({
          embeds: [
            EmbedFactory.buildErrorEmbed(
              'Invalid Target',
              'The target Discord member could not be found in this server.',
            ),
          ],
        });
        return;
      }

      const outcome = await this.studentController.registerStudentManually(
        targetMember,
        rawFullName,
        rawStudentId,
      );
      if (outcome.success) {
        Logger.info('StudentCommandView', 'Manually registered student', {
          callerId: interaction.user.id,
          targetId: targetMember.id,
          studentId: rawStudentId.toUpperCase(),
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

    await interaction.deferReply();

    if (subcommand === 'lookup') {
      const target = interaction.options.getString('target', true);
      const outcome = this.studentController.lookupStudent(target);
      await interaction.editReply({
        embeds: [
          outcome.success
            ? EmbedFactory.buildInfoEmbed(outcome.title, outcome.description)
            : EmbedFactory.buildErrorEmbed(outcome.title, outcome.description),
        ],
      });
      return;
    }

    if (subcommand === 'reset') {
      const target = interaction.options.getString('target', true);
      const outcome = await this.studentController.resetStudent(interaction.guild, target);
      if (outcome.success) {
        Logger.info('StudentCommandView', 'Reset student record', {
          callerId: interaction.user.id,
          target,
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

  /**
   * Completes manual student registration when the moderator submits the /student register modal.
   *
   * @param interaction the modal submit interaction
   */
  public async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.guild || !interaction.customId.startsWith(STUDENT_REGISTER_MODAL_PREFIX)) {
      return;
    }

    const callerMember = await interaction.guild.members.fetch(interaction.user.id);
    if (!this.resourceResolver.isModeratorOrOwner(interaction.guild, callerMember)) {
      await interaction.reply({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            'Permission Denied',
            'Only the Server Owner or moderators can execute `/student` commands.',
          ),
        ],
      });
      return;
    }

    await interaction.deferReply();

    const targetUserId = interaction.customId.slice(STUDENT_REGISTER_MODAL_PREFIX.length);
    const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
    if (!targetMember) {
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            'Invalid Target',
            'The target Discord member could not be found in this server.',
          ),
        ],
      });
      return;
    }

    const rawFullName = interaction.fields.getTextInputValue('full-name-input');
    const rawStudentId = interaction.fields.getTextInputValue('student-id-input');

    const outcome = await this.studentController.registerStudentManually(
      targetMember,
      rawFullName,
      rawStudentId,
    );
    if (outcome.success) {
      Logger.info('StudentCommandView', 'Manually registered student via modal', {
        callerId: interaction.user.id,
        targetId: targetMember.id,
        studentId: rawStudentId.toUpperCase(),
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

  /**
   * Constructs the Discord Modal requesting full name and student identifier for /student register.
   *
   * @param targetUserId the Discord user snowflake ID being registered
   * @returns a ModalBuilder instance
   */
  private buildRegisterModal(targetUserId: string): ModalBuilder {
    const latestCohort = this.appConfig.bot.allowedCohorts.at(-1) ?? '22';
    const fullNameInput = new TextInputBuilder()
      .setCustomId('full-name-input')
      .setLabel('Full Name')
      .setPlaceholder('Example: Nguyễn Văn A')
      .setStyle(TextInputStyle.Short)
      .setMinLength(2)
      .setMaxLength(60)
      .setRequired(true);

    const studentIdInput = new TextInputBuilder()
      .setCustomId('student-id-input')
      .setLabel('Student ID (8 characters)')
      .setPlaceholder(`Example: SE${latestCohort}0001`)
      .setStyle(TextInputStyle.Short)
      .setMinLength(8)
      .setMaxLength(8)
      .setRequired(true);

    return new ModalBuilder()
      .setCustomId(`${STUDENT_REGISTER_MODAL_PREFIX}${targetUserId}`)
      .setTitle('Manual Student Registration')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(fullNameInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(studentIdInput),
      );
  }
}
