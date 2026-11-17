import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  UserSelectMenuBuilder,
  type UserSelectMenuInteraction,
} from 'discord.js';
import type { RoundController, StageKey } from '../controller/RoundController.js';
import type { RoundKey } from '../model/Student.js';
import type { GuildResourceResolver } from '../util/GuildResourceResolver.js';
import { Logger } from '../util/Logger.js';
import { EmbedFactory } from './EmbedFactory.js';

/**
 * Custom identifier prefix for confirming a /round promote or /round revoke operation.
 */
const ROUND_CONFIRM_PREFIX = 'fcode-round-confirm:';

/**
 * Custom identifier prefix for cancelling a pending /round operation.
 */
const ROUND_CANCEL_PREFIX = 'fcode-round-cancel:';

/**
 * Custom identifier prefix for excluding members before executing /round promote or /round revoke.
 */
const ROUND_EXCLUDE_SELECT_PREFIX = 'fcode-round-exclude:';

/**
 * Pending interactive confirmation state for /round promote or /round revoke.
 */
type PendingRoundOperation =
  | {
      kind: 'PROMOTE';
      ownerId: string;
      fromStage: StageKey;
      toStage: StageKey;
      excludeInput: string | null;
      onlyInput: string | null;
      expiresAtMs: number;
    }
  | {
      kind: 'REVOKE';
      ownerId: string;
      round: RoundKey;
      excludeInput: string | null;
      onlyInput: string | null;
      expiresAtMs: number;
    };

/**
 * Presents the owner-only /round slash commands with mandatory confirmation prompts.
 */
export class RoundCommandView {
  private static readonly SESSION_TTL_MS = 10 * 60 * 1000;
  private readonly roundController: RoundController;
  private readonly resourceResolver: GuildResourceResolver;
  private readonly pendingOperations: Map<string, PendingRoundOperation>;

  /**
   * Creates a RoundCommandView bound to RoundController and GuildResourceResolver.
   *
   * @param roundController the round operations controller
   * @param resourceResolver the guild resource resolver
   */
  public constructor(roundController: RoundController, resourceResolver: GuildResourceResolver) {
    this.roundController = roundController;
    this.resourceResolver = resourceResolver;
    this.pendingOperations = new Map<string, PendingRoundOperation>();
  }

  /**
   * Builds the /round slash command definition with promote and revoke subcommands.
   *
   * @returns a SlashCommandBuilder defining /round
   */
  public getCommandDefinition(): SlashCommandBuilder {
    const stageChoices = [
      { name: 'verified', value: 'verified' },
      { name: 'round-1', value: 'round-1' },
      { name: 'round-2', value: 'round-2' },
      { name: 'round-3', value: 'round-3' },
    ];

    const roundChoices = [
      { name: 'round-1', value: 'round-1' },
      { name: 'round-2', value: 'round-2' },
      { name: 'round-3', value: 'round-3' },
    ];

    return new SlashCommandBuilder()
      .setName('round')
      .setDescription('Manage recruitment round promotions and revocations (owner only).')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand((subcommand) =>
        subcommand
          .setName('promote')
          .setDescription('Transition students from one recruitment stage to another.')
          .addStringOption((option) =>
            option
              .setName('from')
              .setDescription('Source stage.')
              .setRequired(true)
              .addChoices(...stageChoices),
          )
          .addStringOption((option) =>
            option
              .setName('to')
              .setDescription('Target stage.')
              .setRequired(true)
              .addChoices(...stageChoices),
          )
          .addStringOption((option) =>
            option
              .setName('exclude')
              .setDescription('Optional @mentions or student IDs to exclude.')
              .setRequired(false),
          )
          .addStringOption((option) =>
            option
              .setName('only')
              .setDescription('Optional @mentions or student IDs to include exclusively.')
              .setRequired(false),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('revoke')
          .setDescription('Bulk remove a round role from eligible members.')
          .addStringOption((option) =>
            option
              .setName('round')
              .setDescription('Round role to remove.')
              .setRequired(true)
              .addChoices(...roundChoices),
          )
          .addStringOption((option) =>
            option
              .setName('exclude')
              .setDescription('Optional @mentions or student IDs to exclude.')
              .setRequired(false),
          )
          .addStringOption((option) =>
            option
              .setName('only')
              .setDescription('Optional @mentions or student IDs to include exclusively.')
              .setRequired(false),
          ),
      ) as SlashCommandBuilder;
  }

  /**
   * Checks whether a component customId belongs to RoundCommandView.
   *
   * @param customId the component custom identifier
   * @returns true if owned by RoundCommandView
   */
  public ownsCustomId(customId: string): boolean {
    return (
      customId.startsWith(ROUND_CONFIRM_PREFIX) ||
      customId.startsWith(ROUND_CANCEL_PREFIX) ||
      customId.startsWith(ROUND_EXCLUDE_SELECT_PREFIX)
    );
  }

  /**
   * Handles incoming /round slash command invocations after enforcing owner-only authorization.
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
    if (!this.resourceResolver.isOwnerOrHasOwnerRole(interaction.guild, callerMember)) {
      await interaction.reply({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            'Owner Authorization Required',
            'Only the Server Owner or holders of the configured owner role can execute `/round` commands.',
          ),
        ],
      });
      return;
    }

    await interaction.deferReply();

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'promote') {
      await this.handlePromoteCommand(interaction);
      return;
    }

    if (subcommand === 'revoke') {
      await this.handleRevokeCommand(interaction);
    }
  }

  /**
   * Handles Confirm and Cancel button clicks for pending /round operations.
   *
   * @param interaction the Discord button interaction
   */
  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.guild) {
      return;
    }

    if (interaction.customId.startsWith(ROUND_CANCEL_PREFIX)) {
      const token = interaction.customId.slice(ROUND_CANCEL_PREFIX.length);
      const pending = this.pendingOperations.get(token);
      if (!pending || pending.ownerId !== interaction.user.id) {
        await interaction.reply({
          embeds: [
            EmbedFactory.buildErrorEmbed(
              'Unauthorized or Expired',
              'Only the command invoker can cancel this pending operation.',
            ),
          ],
        });
        return;
      }

      this.pendingOperations.delete(token);
      await interaction.update({
        embeds: [
          EmbedFactory.buildWarningEmbed(
            'Operation Cancelled',
            'The pending `/round` operation was cancelled. No roles or records were modified.',
          ),
        ],
        components: [],
      });
      return;
    }

    if (!interaction.customId.startsWith(ROUND_CONFIRM_PREFIX)) {
      return;
    }

    const token = interaction.customId.slice(ROUND_CONFIRM_PREFIX.length);
    const pending = this.pendingOperations.get(token);

    if (!pending || pending.ownerId !== interaction.user.id || pending.expiresAtMs < Date.now()) {
      await interaction.update({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            'Session Expired',
            'This confirmation prompt has expired. Please run the `/round` command again.',
          ),
        ],
        components: [],
      });
      return;
    }

    this.pendingOperations.delete(token);
    await interaction.deferUpdate();

    if (pending.kind === 'PROMOTE') {
      const candidates = this.roundController.resolveCandidates(
        pending.fromStage,
        pending.excludeInput,
        pending.onlyInput,
      );
      const result = await this.roundController.transitionStudents(
        interaction.guild,
        candidates,
        pending.toStage,
      );
      Logger.info('RoundCommandView', 'Completed round promote operation', {
        callerId: interaction.user.id,
        fromStage: pending.fromStage,
        toStage: pending.toStage,
        updatedCount: result.updatedCount,
        failedCount: result.failedMembers.length,
      });

      await interaction.editReply({
        embeds: [
          EmbedFactory.buildBatchMutationEmbed(
            'Round Transition Complete',
            `Transitioned eligible students from \`${pending.fromStage}\` to \`${pending.toStage}\`.`,
            result,
          ),
        ],
        components: [],
      });
      return;
    }

    const candidates = this.roundController.resolveCandidates(
      pending.round,
      pending.excludeInput,
      pending.onlyInput,
    );
    const result = await this.roundController.revokeRoundFromCandidates(
      interaction.guild,
      candidates,
      pending.round,
    );
    Logger.info('RoundCommandView', 'Completed round revoke operation', {
      callerId: interaction.user.id,
      round: pending.round,
      updatedCount: result.updatedCount,
      failedCount: result.failedMembers.length,
    });

    await interaction.editReply({
      embeds: [
        EmbedFactory.buildBatchMutationEmbed(
          'Round Role Revoked',
          `Removed \`${pending.round}\` from eligible members.`,
          result,
        ),
      ],
      components: [],
    });
  }

  /**
   * Handles multi-user UserSelectMenu exclusions for /round promote or /round revoke.
   *
   * @param interaction the Discord user select menu interaction
   */
  public async handleUserSelectMenu(interaction: UserSelectMenuInteraction): Promise<void> {
    if (!interaction.guild || !interaction.customId.startsWith(ROUND_EXCLUDE_SELECT_PREFIX)) {
      return;
    }

    const token = interaction.customId.slice(ROUND_EXCLUDE_SELECT_PREFIX.length);
    const pending = this.pendingOperations.get(token);
    if (!pending || pending.ownerId !== interaction.user.id || pending.expiresAtMs < Date.now()) {
      await interaction.update({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            'Session Expired',
            'This confirmation prompt has expired. Please run the `/round` command again.',
          ),
        ],
        components: [],
      });
      return;
    }

    this.pendingOperations.delete(token);
    await interaction.deferUpdate();

    const selectedDiscordIds = Array.from(interaction.users.keys());
    const excludeMentionString = selectedDiscordIds.map((id) => `<@${id}>`).join(' ');

    if (pending.kind === 'PROMOTE') {
      const candidates = this.roundController.resolveCandidates(
        pending.fromStage,
        excludeMentionString,
        null,
      );
      const result = await this.roundController.transitionStudents(
        interaction.guild,
        candidates,
        pending.toStage,
      );
      Logger.info('RoundCommandView', 'Completed round promote with select exclusions', {
        callerId: interaction.user.id,
        fromStage: pending.fromStage,
        toStage: pending.toStage,
        excludedCount: selectedDiscordIds.length,
        updatedCount: result.updatedCount,
        failedCount: result.failedMembers.length,
      });

      await interaction.editReply({
        embeds: [
          EmbedFactory.buildBatchMutationEmbed(
            'Round Transition Complete',
            `Transitioned students from \`${pending.fromStage}\` to \`${pending.toStage}\` excluding \`${selectedDiscordIds.length}\` selected member(s).`,
            result,
          ),
        ],
        components: [],
      });
      return;
    }

    const candidates = this.roundController.resolveCandidates(
      pending.round,
      excludeMentionString,
      null,
    );
    const result = await this.roundController.revokeRoundFromCandidates(
      interaction.guild,
      candidates,
      pending.round,
    );
    Logger.info('RoundCommandView', 'Completed round revoke with select exclusions', {
      callerId: interaction.user.id,
      round: pending.round,
      excludedCount: selectedDiscordIds.length,
      updatedCount: result.updatedCount,
      failedCount: result.failedMembers.length,
    });

    await interaction.editReply({
      embeds: [
        EmbedFactory.buildBatchMutationEmbed(
          'Round Role Revoked',
          `Removed \`${pending.round}\` from eligible members excluding \`${selectedDiscordIds.length}\` selected member(s).`,
          result,
        ),
      ],
      components: [],
    });
  }

  /**
   * Validates /round promote arguments and displays a mandatory confirmation prompt.
   *
   * @param interaction the slash command interaction
   */
  private async handlePromoteCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const fromStage = interaction.options.getString('from', true) as StageKey;
    const toStage = interaction.options.getString('to', true) as StageKey;
    const excludeInput = interaction.options.getString('exclude');
    const onlyInput = interaction.options.getString('only');

    if (excludeInput && onlyInput) {
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            'Conflicting Filters',
            'Specify either `exclude` or `only`, never both at the same time.',
          ),
        ],
      });
      return;
    }

    if (fromStage === toStage) {
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            'Invalid Transition',
            '`from` and `to` must be different stages.',
          ),
        ],
      });
      return;
    }

    const candidates = this.roundController.resolveCandidates(fromStage, excludeInput, onlyInput);
    if (candidates.length === 0) {
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildWarningEmbed(
            'No Eligible Candidates',
            `No verified students matched \`${fromStage}\` with the provided filters.`,
          ),
        ],
      });
      return;
    }

    this.pruneExpiredSessions();
    const token = `${interaction.user.id}-${Date.now()}`;
    this.pendingOperations.set(token, {
      kind: 'PROMOTE',
      ownerId: interaction.user.id,
      fromStage,
      toStage,
      excludeInput,
      onlyInput,
      expiresAtMs: Date.now() + RoundCommandView.SESSION_TTL_MS,
    });

    const components: Array<
      ActionRowBuilder<UserSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>
    > = [];

    if (!excludeInput && !onlyInput) {
      const excludeSelect = new UserSelectMenuBuilder()
        .setCustomId(`${ROUND_EXCLUDE_SELECT_PREFIX}${token}`)
        .setPlaceholder('Optional: select members to EXCLUDE, then submit')
        .setMinValues(1)
        .setMaxValues(25);
      components.push(new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(excludeSelect));
    }

    const confirmButton = new ButtonBuilder()
      .setCustomId(`${ROUND_CONFIRM_PREFIX}${token}`)
      .setLabel(`Confirm Transition (${candidates.length})`)
      .setStyle(ButtonStyle.Success);
    const cancelButton = new ButtonBuilder()
      .setCustomId(`${ROUND_CANCEL_PREFIX}${token}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary);

    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, cancelButton),
    );

    await interaction.editReply({
      embeds: [
        EmbedFactory.buildInfoEmbed(
          'Confirm Round Transition',
          `Ready to transition \`${candidates.length}\` student(s) from \`${fromStage}\` to \`${toStage}\`.\n\nClick **Confirm** to apply changes to Discord and SQLite, or **Cancel** to abort.`,
        ),
      ],
      components,
    });
  }

  /**
   * Validates /round revoke arguments and displays a mandatory confirmation prompt.
   *
   * @param interaction the slash command interaction
   */
  private async handleRevokeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const round = interaction.options.getString('round', true) as RoundKey;
    const excludeInput = interaction.options.getString('exclude');
    const onlyInput = interaction.options.getString('only');

    if (excludeInput && onlyInput) {
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            'Conflicting Filters',
            'Specify either `exclude` or `only`, never both at the same time.',
          ),
        ],
      });
      return;
    }

    const candidates = this.roundController.resolveCandidates(round, excludeInput, onlyInput);
    if (candidates.length === 0) {
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildWarningEmbed(
            'No Eligible Candidates',
            `No verified students currently hold \`${round}\` with the provided filters.`,
          ),
        ],
      });
      return;
    }

    this.pruneExpiredSessions();
    const token = `${interaction.user.id}-${Date.now()}`;
    this.pendingOperations.set(token, {
      kind: 'REVOKE',
      ownerId: interaction.user.id,
      round,
      excludeInput,
      onlyInput,
      expiresAtMs: Date.now() + RoundCommandView.SESSION_TTL_MS,
    });

    const components: Array<
      ActionRowBuilder<UserSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>
    > = [];

    if (!excludeInput && !onlyInput) {
      const excludeSelect = new UserSelectMenuBuilder()
        .setCustomId(`${ROUND_EXCLUDE_SELECT_PREFIX}${token}`)
        .setPlaceholder('Optional: select members to EXCLUDE from revocation')
        .setMinValues(1)
        .setMaxValues(25);
      components.push(new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(excludeSelect));
    }

    const confirmButton = new ButtonBuilder()
      .setCustomId(`${ROUND_CONFIRM_PREFIX}${token}`)
      .setLabel(`Confirm Revoke (${candidates.length})`)
      .setStyle(ButtonStyle.Danger);
    const cancelButton = new ButtonBuilder()
      .setCustomId(`${ROUND_CANCEL_PREFIX}${token}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary);

    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, cancelButton),
    );

    await interaction.editReply({
      embeds: [
        EmbedFactory.buildInfoEmbed(
          'Confirm Round Revocation',
          `Ready to remove \`${round}\` from \`${candidates.length}\` student(s).\n\nClick **Confirm** to apply changes to Discord and SQLite, or **Cancel** to abort.`,
        ),
      ],
      components,
    });
  }

  /**
   * Removes expired interactive prompts from in-memory session maps.
   */
  private pruneExpiredSessions(): void {
    const now = Date.now();
    for (const [token, item] of this.pendingOperations.entries()) {
      if (item.expiresAtMs < now) {
        this.pendingOperations.delete(token);
      }
    }
  }
}
