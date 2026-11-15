import {
  type ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { StudentController } from '../controller/StudentController.js';
import type { GuildResourceResolver } from '../util/GuildResourceResolver.js';
import { Logger } from '../util/Logger.js';
import { EmbedFactory } from './EmbedFactory.js';

/**
 * Presents the /student slash command group for moderators and the server owner.
 */
export class StudentCommandView {
  private readonly studentController: StudentController;
  private readonly resourceResolver: GuildResourceResolver;

  /**
   * Creates a StudentCommandView bound to StudentController and GuildResourceResolver.
   *
   * @param studentController the student management controller
   * @param resourceResolver the guild resource resolver
   */
  public constructor(
    studentController: StudentController,
    resourceResolver: GuildResourceResolver,
  ) {
    this.studentController = studentController;
    this.resourceResolver = resourceResolver;
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
          .setDescription('Look up a student record by student ID or Discord user.')
          .addStringOption((option) =>
            option
              .setName('student-id')
              .setDescription('Student ID to look up (for example, SE220001).')
              .setRequired(false),
          )
          .addUserOption((option) =>
            option.setName('user').setDescription('Discord user to look up.').setRequired(false),
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
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName('student-id')
              .setDescription('Student ID (for example, SE220001).')
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('reset')
          .setDescription('Remove a student database record and clear their recruitment roles.')
          .addStringOption((option) =>
            option.setName('student-id').setDescription('Student ID to reset.').setRequired(false),
          )
          .addUserOption((option) =>
            option.setName('user').setDescription('Discord user to reset.').setRequired(false),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('sync')
          .setDescription('Synchronize SQLite student records (nickname and roles) to Discord.')
          .addStringOption((option) =>
            option
              .setName('student-id')
              .setDescription('Optional Student ID to sync (omit both options to sync all).')
              .setRequired(false),
          )
          .addUserOption((option) =>
            option
              .setName('user')
              .setDescription('Optional Discord user to sync (omit both options to sync all).')
              .setRequired(false),
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
    await interaction.deferReply();

    if (subcommand === 'lookup') {
      const studentId = interaction.options.getString('student-id');
      const user = interaction.options.getUser('user');
      if (!studentId && !user) {
        await interaction.editReply({
          embeds: [
            EmbedFactory.buildErrorEmbed(
              'Missing Target',
              'Provide either `student-id` or `user` to perform a lookup.',
            ),
          ],
        });
        return;
      }

      const outcome = this.studentController.lookupStudent(studentId, user?.id ?? null);
      await interaction.editReply({
        embeds: [
          outcome.success
            ? EmbedFactory.buildInfoEmbed(outcome.title, outcome.description)
            : EmbedFactory.buildErrorEmbed(outcome.title, outcome.description),
        ],
      });
      return;
    }

    if (subcommand === 'register') {
      const targetUser = interaction.options.getUser('user', true);
      const rawFullName = interaction.options.getString('full-name', true);
      const rawStudentId = interaction.options.getString('student-id', true);

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

    if (subcommand === 'reset') {
      const studentId = interaction.options.getString('student-id');
      const user = interaction.options.getUser('user');
      if (!studentId && !user) {
        await interaction.editReply({
          embeds: [
            EmbedFactory.buildErrorEmbed(
              'Missing Target',
              'Provide either `student-id` or `user` to reset a student.',
            ),
          ],
        });
        return;
      }

      const targetMember = user
        ? await interaction.guild.members.fetch(user.id).catch(() => null)
        : null;
      const outcome = await this.studentController.resetStudent(
        interaction.guild,
        studentId,
        targetMember,
      );
      if (outcome.success) {
        Logger.info('StudentCommandView', 'Reset student record', {
          callerId: interaction.user.id,
          studentId: studentId ?? undefined,
          targetUserId: user?.id ?? undefined,
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

    if (subcommand === 'sync') {
      const studentId = interaction.options.getString('student-id');
      const user = interaction.options.getUser('user');
      const outcome = await this.studentController.syncStudentsToDiscord(
        interaction.guild,
        studentId,
        user?.id ?? null,
      );
      if (outcome.success) {
        Logger.info('StudentCommandView', 'Synchronized database records to Discord', {
          callerId: interaction.user.id,
          studentId: studentId ?? undefined,
          targetUserId: user?.id ?? undefined,
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
    }
  }
}
