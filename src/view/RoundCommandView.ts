import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  ChannelType,
  type ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  UserSelectMenuBuilder,
  type UserSelectMenuInteraction,
} from 'discord.js';
import type { AppConfig } from '../config/ConfigSchema.js';
import type { RoundController } from '../controller/RoundController.js';
import type { RoundKey } from '../model/Student.js';
import type { GuildResourceResolver } from '../util/GuildResourceResolver.js';
import { InputValidator } from '../util/InputValidator.js';
import { Logger } from '../util/Logger.js';
import { EmbedFactory } from './EmbedFactory.js';
import { VERIFY_PANEL_BUTTON_ID } from './VerifyCommandView.js';

/**
 * Custom identifier prefix for advancing all eligible students without exclusions.
 */
const ADVANCE_CONFIRM_PREFIX = 'fcode-round-advance-confirm:';

/**
 * Custom identifier prefix for selecting members to exclude during round promotion.
 */
const ADVANCE_EXCLUDE_SELECT_PREFIX = 'fcode-round-advance-exclude:';

/**
 * Custom identifier prefix for multi-user round role revocation select menus.
 */
const REVOKE_SELECT_PREFIX = 'fcode-round-revoke-select:';

/**
 * Pending interactive round advance confirmation context.
 */
interface PendingAdvanceOperation {
  ownerId: string;
  fromRound: 'round-1' | 'round-2';
  toRound: 'round-2' | 'round-3';
  expiresAtMs: number;
}

/**
 * Pending interactive multi-user revoke context.
 */
interface PendingRevokeOperation {
  ownerId: string;
  round: RoundKey;
  expiresAtMs: number;
}

/**
 * Presents the owner-only /round slash commands and multi-user select interactions.
 */
export class RoundCommandView {
  private static readonly SESSION_TTL_MS = 10 * 60 * 1000;
  private readonly appConfig: AppConfig;
  private readonly roundController: RoundController;
  private readonly resourceResolver: GuildResourceResolver;
  private readonly pendingAdvances: Map<string, PendingAdvanceOperation>;
  private readonly pendingRevokes: Map<string, PendingRevokeOperation>;

  /**
   * Creates a RoundCommandView bound to AppConfig, RoundController, and GuildResourceResolver.
   *
   * @param appConfig the validated application configuration
   * @param roundController the round operations controller
   * @param resourceResolver the guild resource resolver
   */
  public constructor(
    appConfig: AppConfig,
    roundController: RoundController,
    resourceResolver: GuildResourceResolver,
  ) {
    this.appConfig = appConfig;
    this.roundController = roundController;
    this.resourceResolver = resourceResolver;
    this.pendingAdvances = new Map<string, PendingAdvanceOperation>();
    this.pendingRevokes = new Map<string, PendingRevokeOperation>();
  }

  /**
   * Builds the /round slash command definition with advance, revoke, verify, and verify-panel subcommands.
   *
   * @returns a SlashCommandBuilder defining /round
   */
  public getCommandDefinition(): SlashCommandBuilder {
    return new SlashCommandBuilder()
      .setName('round')
      .setDescription('Manage recruitment rounds and verification controls (owner only).')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand((subcommand) =>
        subcommand
          .setName('advance')
          .setDescription('Advance students from one recruitment round to a higher round.')
          .addStringOption((option) =>
            option
              .setName('from')
              .setDescription('Source recruitment round.')
              .setRequired(true)
              .addChoices(
                { name: 'round-1', value: 'round-1' },
                { name: 'round-2', value: 'round-2' },
              ),
          )
          .addStringOption((option) =>
            option
              .setName('to')
              .setDescription('Target recruitment round (defaults to the next round).')
              .setRequired(false)
              .addChoices(
                { name: 'round-2', value: 'round-2' },
                { name: 'round-3', value: 'round-3' },
              ),
          )
          .addStringOption((option) =>
            option
              .setName('exclude')
              .setDescription('Optional @mentions or student IDs to exclude from promotion.')
              .setRequired(false),
          )
          .addStringOption((option) =>
            option
              .setName('only')
              .setDescription('Optional @mentions or student IDs to promote exclusively.')
              .setRequired(false),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('revoke')
          .setDescription('Bulk remove a round role from multiple members.')
          .addStringOption((option) =>
            option
              .setName('role')
              .setDescription('Round role to remove.')
              .setRequired(true)
              .addChoices(
                { name: 'round-1', value: 'round-1' },
                { name: 'round-2', value: 'round-2' },
                { name: 'round-3', value: 'round-3' },
              ),
          )
          .addStringOption((option) =>
            option
              .setName('users')
              .setDescription(
                'Optional @mentions or student IDs; omit to open the multi-user picker.',
              )
              .setRequired(false),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('verify')
          .setDescription('Open or close the candidate verification gate.')
          .addBooleanOption((option) =>
            option
              .setName('enabled')
              .setDescription('Set to true to allow new verifications, or false to close.')
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('verify-panel')
          .setDescription('Post or update the persistent verification button panel in a channel.')
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Target text channel (defaults to the current channel).')
              .addChannelTypes(ChannelType.GuildText)
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
      customId.startsWith(ADVANCE_CONFIRM_PREFIX) ||
      customId.startsWith(ADVANCE_EXCLUDE_SELECT_PREFIX) ||
      customId.startsWith(REVOKE_SELECT_PREFIX)
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

    const subcommand = interaction.options.getSubcommand();
    await interaction.deferReply();

    if (subcommand === 'verify') {
      const enabled = interaction.options.getBoolean('enabled', true);
      this.roundController.setVerificationEnabled(enabled);
      Logger.info('RoundCommandView', 'Updated verification gate state', {
        callerId: interaction.user.id,
        enabled,
      });
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildSuccessEmbed(
            'Verification Gate Updated',
            `Candidate verification is now \`${enabled ? 'OPEN' : 'CLOSED'}\`.`,
          ),
        ],
      });
      return;
    }

    if (subcommand === 'verify-panel') {
      await this.handleVerifyPanelCommand(interaction);
      return;
    }

    if (subcommand === 'advance') {
      await this.handleAdvanceCommand(interaction);
      return;
    }

    if (subcommand === 'revoke') {
      await this.handleRevokeCommand(interaction);
    }
  }

  /**
   * Handles confirmation button clicks to advance all eligible students without exclusions.
   *
   * @param interaction the Discord button interaction
   */
  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.guild || !interaction.customId.startsWith(ADVANCE_CONFIRM_PREFIX)) {
      return;
    }

    const token = interaction.customId.slice(ADVANCE_CONFIRM_PREFIX.length);
    const pending = this.pendingAdvances.get(token);

    if (!pending || pending.ownerId !== interaction.user.id || pending.expiresAtMs < Date.now()) {
      await interaction.update({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            'Session Expired',
            'This round promotion prompt has expired. Please run `/round advance` again.',
          ),
        ],
        components: [],
      });
      return;
    }

    this.pendingAdvances.delete(token);
    await interaction.deferUpdate();

    const candidates = this.roundController.resolveCandidatesForAdvance(pending.fromRound);
    const result = await this.roundController.advanceStudentsToRound(
      interaction.guild,
      candidates,
      pending.toRound,
    );
    Logger.info('RoundCommandView', 'Completed round advancement via confirmation button', {
      callerId: interaction.user.id,
      fromRound: pending.fromRound,
      toRound: pending.toRound,
      updatedCount: result.updatedCount,
      failedCount: result.failedMembers.length,
    });

    await interaction.editReply({
      embeds: [
        EmbedFactory.buildBatchMutationEmbed(
          'Round Advancement Complete',
          `Promoted eligible students from \`${pending.fromRound}\` to \`${pending.toRound}\`.`,
          result,
        ),
      ],
      components: [],
    });
  }

  /**
   * Handles multi-user UserSelectMenu selections for advance exclusions and revoke.
   *
   * @param interaction the Discord user select menu interaction
   */
  public async handleUserSelectMenu(interaction: UserSelectMenuInteraction): Promise<void> {
    if (!interaction.guild) {
      return;
    }

    const selectedDiscordIds = Array.from(interaction.users.keys());

    if (interaction.customId.startsWith(ADVANCE_EXCLUDE_SELECT_PREFIX)) {
      const token = interaction.customId.slice(ADVANCE_EXCLUDE_SELECT_PREFIX.length);
      const pending = this.pendingAdvances.get(token);
      if (!pending || pending.ownerId !== interaction.user.id || pending.expiresAtMs < Date.now()) {
        await interaction.update({
          embeds: [
            EmbedFactory.buildErrorEmbed('Session Expired', 'Please run `/round advance` again.'),
          ],
          components: [],
        });
        return;
      }

      this.pendingAdvances.delete(token);
      await interaction.deferUpdate();

      const excludeMentionString = selectedDiscordIds.map((id) => `<@${id}>`).join(' ');
      const candidates = this.roundController.resolveCandidatesForAdvance(
        pending.fromRound,
        excludeMentionString,
        null,
      );
      const result = await this.roundController.advanceStudentsToRound(
        interaction.guild,
        candidates,
        pending.toRound,
      );
      Logger.info('RoundCommandView', 'Completed round advancement with exclusions', {
        callerId: interaction.user.id,
        fromRound: pending.fromRound,
        toRound: pending.toRound,
        excludedCount: selectedDiscordIds.length,
        updatedCount: result.updatedCount,
        failedCount: result.failedMembers.length,
      });

      await interaction.editReply({
        embeds: [
          EmbedFactory.buildBatchMutationEmbed(
            'Round Advancement Complete',
            `Promoted students from \`${pending.fromRound}\` to \`${pending.toRound}\` excluding \`${selectedDiscordIds.length}\` selected member(s).`,
            result,
          ),
        ],
        components: [],
      });
      return;
    }

    if (interaction.customId.startsWith(REVOKE_SELECT_PREFIX)) {
      const token = interaction.customId.slice(REVOKE_SELECT_PREFIX.length);
      const pending = this.pendingRevokes.get(token);
      if (!pending || pending.ownerId !== interaction.user.id || pending.expiresAtMs < Date.now()) {
        await interaction.update({
          embeds: [
            EmbedFactory.buildErrorEmbed('Session Expired', 'Please run `/round revoke` again.'),
          ],
          components: [],
        });
        return;
      }

      this.pendingRevokes.delete(token);
      await interaction.deferUpdate();

      const result = await this.roundController.revokeRoundRoleFromTargets(
        interaction.guild,
        pending.round,
        selectedDiscordIds,
        [],
      );
      Logger.info('RoundCommandView', 'Completed round revocation via user select menu', {
        callerId: interaction.user.id,
        round: pending.round,
        updatedCount: result.updatedCount,
        failedCount: result.failedMembers.length,
      });

      await interaction.editReply({
        embeds: [
          EmbedFactory.buildBatchMutationEmbed(
            'Round Role Revoked',
            `Removed \`${pending.round}\` from selected members.`,
            result,
          ),
        ],
        components: [],
      });
    }
  }

  /**
   * Deploys or updates the persistent verification panel message in the selected text channel.
   *
   * @param interaction the slash command interaction
   */
  private async handleVerifyPanelCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
      return;
    }

    const optionChannel = interaction.options.getChannel<ChannelType.GuildText>('channel');
    const targetChannel =
      optionChannel ??
      (interaction.channel?.type === ChannelType.GuildText ? interaction.channel : null);

    if (!targetChannel) {
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            'Invalid Channel',
            'Select a valid server text channel to post the verification panel.',
          ),
        ],
      });
      return;
    }

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

    const recentMessages = await targetChannel.messages.fetch({ limit: 20 });
    const existingPanel = recentMessages.find(
      (message) =>
        message.author.id === interaction.client.user.id && message.components.length > 0,
    );

    if (existingPanel) {
      await existingPanel.edit({ embeds: [panelEmbed], components: [panelRow] });
      Logger.info('RoundCommandView', 'Updated existing verification panel', {
        callerId: interaction.user.id,
        channelId: targetChannel.id,
      });
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildSuccessEmbed(
            'Verification Panel Updated',
            `Updated the existing verification panel in <#${targetChannel.id}>.`,
          ),
        ],
      });
      return;
    }

    await targetChannel.send({ embeds: [panelEmbed], components: [panelRow] });
    Logger.info('RoundCommandView', 'Posted verification panel', {
      callerId: interaction.user.id,
      channelId: targetChannel.id,
    });
    await interaction.editReply({
      embeds: [
        EmbedFactory.buildSuccessEmbed(
          'Verification Panel Posted',
          `Posted the verification panel in <#${targetChannel.id}>.`,
        ),
      ],
    });
  }

  /**
   * Processes /round advance inline or opens the interactive multi-user exclusion prompt.
   *
   * @param interaction the slash command interaction
   */
  private async handleAdvanceCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
      return;
    }

    const fromRound = interaction.options.getString('from', true) as 'round-1' | 'round-2';
    const rawToRound = interaction.options.getString('to') as 'round-2' | 'round-3' | null;
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

    const targetRound = this.roundController.resolveTargetRound(fromRound, rawToRound);
    if (!targetRound) {
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            'Invalid Round Progression',
            `Cannot advance from \`${fromRound}\` to \`${rawToRound ?? 'unknown'}\`.`,
          ),
        ],
      });
      return;
    }

    if (excludeInput || onlyInput) {
      const candidates = this.roundController.resolveCandidatesForAdvance(
        fromRound,
        excludeInput,
        onlyInput,
      );
      const result = await this.roundController.advanceStudentsToRound(
        interaction.guild,
        candidates,
        targetRound,
      );
      Logger.info('RoundCommandView', 'Completed filtered round advancement', {
        callerId: interaction.user.id,
        fromRound,
        toRound: targetRound,
        updatedCount: result.updatedCount,
        failedCount: result.failedMembers.length,
      });

      await interaction.editReply({
        embeds: [
          EmbedFactory.buildBatchMutationEmbed(
            'Round Advancement Complete',
            `Promoted filtered students from \`${fromRound}\` to \`${targetRound}\`.`,
            result,
          ),
        ],
      });
      return;
    }

    const allEligible = this.roundController.resolveCandidatesForAdvance(fromRound);
    if (allEligible.length === 0) {
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildWarningEmbed(
            'No Eligible Candidates',
            `No verified students currently hold \`${fromRound}\`.`,
          ),
        ],
      });
      return;
    }

    this.pruneExpiredSessions();
    const token = `${interaction.user.id}-${Date.now()}`;
    this.pendingAdvances.set(token, {
      ownerId: interaction.user.id,
      fromRound,
      toRound: targetRound,
      expiresAtMs: Date.now() + RoundCommandView.SESSION_TTL_MS,
    });

    const excludeSelect = new UserSelectMenuBuilder()
      .setCustomId(`${ADVANCE_EXCLUDE_SELECT_PREFIX}${token}`)
      .setPlaceholder('Optional: select members to EXCLUDE, then submit')
      .setMinValues(1)
      .setMaxValues(25);

    const confirmButton = new ButtonBuilder()
      .setCustomId(`${ADVANCE_CONFIRM_PREFIX}${token}`)
      .setLabel(`Advance All ${allEligible.length} Students`)
      .setStyle(ButtonStyle.Success);

    await interaction.editReply({
      embeds: [
        EmbedFactory.buildInfoEmbed(
          'Confirm Round Advancement',
          `Ready to advance \`${allEligible.length}\` student(s) from \`${fromRound}\` to \`${targetRound}\`.\n\nUse the user selector below to exclude dropped or eliminated candidates, or click the button to advance everyone.`,
        ),
      ],
      components: [
        new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(excludeSelect),
        new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton),
      ],
    });
  }

  /**
   * Processes /round revoke inline or opens the multi-user picker.
   *
   * @param interaction the slash command interaction
   */
  private async handleRevokeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
      return;
    }

    const round = interaction.options.getString('role', true) as RoundKey;
    const usersInput = interaction.options.getString('users');

    if (usersInput && usersInput.trim().length > 0) {
      const tokens = InputValidator.parseTargetTokens(usersInput);
      const result = await this.roundController.revokeRoundRoleFromTargets(
        interaction.guild,
        round,
        tokens.discordIds,
        tokens.studentIds,
      );
      Logger.info('RoundCommandView', 'Completed inline round revocation', {
        callerId: interaction.user.id,
        round,
        updatedCount: result.updatedCount,
        failedCount: result.failedMembers.length,
      });
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildBatchMutationEmbed(
            'Round Role Revoked',
            `Removed \`${round}\` from specified targets.`,
            result,
          ),
        ],
      });
      return;
    }

    this.pruneExpiredSessions();
    const token = `${interaction.user.id}-${Date.now()}`;
    this.pendingRevokes.set(token, {
      ownerId: interaction.user.id,
      round,
      expiresAtMs: Date.now() + RoundCommandView.SESSION_TTL_MS,
    });

    const userSelect = new UserSelectMenuBuilder()
      .setCustomId(`${REVOKE_SELECT_PREFIX}${token}`)
      .setPlaceholder(`Select up to 25 members to remove ${round} from`)
      .setMinValues(1)
      .setMaxValues(25);

    await interaction.editReply({
      embeds: [
        EmbedFactory.buildInfoEmbed(
          'Select Members to Revoke',
          `Choose one or more members below to remove \`${round}\` from both Discord and SQLite.`,
        ),
      ],
      components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect)],
    });
  }

  /**
   * Removes expired interactive prompts from in-memory session maps.
   */
  private pruneExpiredSessions(): void {
    const now = Date.now();
    for (const [token, item] of this.pendingAdvances.entries()) {
      if (item.expiresAtMs < now) {
        this.pendingAdvances.delete(token);
      }
    }
    for (const [token, item] of this.pendingRevokes.entries()) {
      if (item.expiresAtMs < now) {
        this.pendingRevokes.delete(token);
      }
    }
  }
}
