import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  ChannelType,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  UserSelectMenuBuilder,
  type UserSelectMenuInteraction,
} from 'discord.js';
import type { AppConfig } from '../config/ConfigSchema.js';
import type { ChallengeController } from '../controller/ChallengeController.js';
import type { ChallengeStageKey } from '../model/Student.js';
import type { GuildResourceResolver } from '../util/GuildResourceResolver.js';
import { InputValidator } from '../util/InputValidator.js';
import { EmbedFactory } from './EmbedFactory.js';
import { VERIFY_PANEL_BUTTON_ID } from './VerifyCommandView.js';

/**
 * Custom identifier prefix for advancing all eligible students without exclusions.
 */
const ADVANCE_CONFIRM_PREFIX = 'fcode-challenge-advance-confirm:';

/**
 * Custom identifier prefix for selecting members to exclude during stage promotion.
 */
const ADVANCE_EXCLUDE_SELECT_PREFIX = 'fcode-challenge-advance-exclude:';

/**
 * Custom identifier prefix for multi-user stage role revocation select menus.
 */
const REVOKE_SELECT_PREFIX = 'fcode-challenge-revoke-select:';

/**
 * Pending interactive stage advance confirmation context.
 */
interface PendingAdvanceOperation {
  ownerId: string;
  fromStage: 'challenge-1' | 'challenge-2';
  toStage: 'challenge-2' | 'challenge-3';
  expiresAtMs: number;
}

/**
 * Pending interactive multi-user revoke context.
 */
interface PendingRevokeOperation {
  ownerId: string;
  stage: ChallengeStageKey;
  expiresAtMs: number;
}

/**
 * Presents the owner-only /challenge slash commands and multi-user select interactions.
 */
export class ChallengeCommandView {
  private static readonly SESSION_TTL_MS = 10 * 60 * 1000;
  private readonly appConfig: AppConfig;
  private readonly challengeController: ChallengeController;
  private readonly resourceResolver: GuildResourceResolver;
  private readonly pendingAdvances: Map<string, PendingAdvanceOperation>;
  private readonly pendingRevokes: Map<string, PendingRevokeOperation>;

  /**
   * Creates a ChallengeCommandView bound to AppConfig, ChallengeController, and GuildResourceResolver.
   *
   * @param appConfig the validated application configuration
   * @param challengeController the challenge operations controller
   * @param resourceResolver the guild resource resolver
   */
  public constructor(
    appConfig: AppConfig,
    challengeController: ChallengeController,
    resourceResolver: GuildResourceResolver,
  ) {
    this.appConfig = appConfig;
    this.challengeController = challengeController;
    this.resourceResolver = resourceResolver;
    this.pendingAdvances = new Map<string, PendingAdvanceOperation>();
    this.pendingRevokes = new Map<string, PendingRevokeOperation>();
  }

  /**
   * Builds the /challenge slash command definition with advance, revoke, verify, and verify-panel subcommands.
   *
   * @returns a SlashCommandBuilder defining /challenge
   */
  public getCommandDefinition(): SlashCommandBuilder {
    return new SlashCommandBuilder()
      .setName('challenge')
      .setDescription('Manage recruitment stages and verification controls (owner only).')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand((subcommand) =>
        subcommand
          .setName('advance')
          .setDescription('Advance students from one challenge stage to a higher stage.')
          .addStringOption((option) =>
            option
              .setName('from')
              .setDescription('Source challenge stage.')
              .setRequired(true)
              .addChoices(
                { name: 'challenge-1', value: 'challenge-1' },
                { name: 'challenge-2', value: 'challenge-2' },
              ),
          )
          .addStringOption((option) =>
            option
              .setName('to')
              .setDescription('Target challenge stage (defaults to the next stage).')
              .setRequired(false)
              .addChoices(
                { name: 'challenge-2', value: 'challenge-2' },
                { name: 'challenge-3', value: 'challenge-3' },
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
          .setDescription('Bulk remove a challenge stage role from multiple members.')
          .addStringOption((option) =>
            option
              .setName('role')
              .setDescription('Challenge stage role to remove.')
              .setRequired(true)
              .addChoices(
                { name: 'challenge-1', value: 'challenge-1' },
                { name: 'challenge-2', value: 'challenge-2' },
                { name: 'challenge-3', value: 'challenge-3' },
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
   * Checks whether a component customId belongs to ChallengeCommandView.
   *
   * @param customId the component custom identifier
   * @returns true if owned by ChallengeCommandView
   */
  public ownsCustomId(customId: string): boolean {
    return (
      customId.startsWith(ADVANCE_CONFIRM_PREFIX) ||
      customId.startsWith(ADVANCE_EXCLUDE_SELECT_PREFIX) ||
      customId.startsWith(REVOKE_SELECT_PREFIX)
    );
  }

  /**
   * Handles incoming /challenge slash command invocations after enforcing owner-only authorization.
   *
   * @param interaction the slash command interaction
   */
  public async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
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
        flags: MessageFlags.Ephemeral,
        embeds: [
          EmbedFactory.buildErrorEmbed(
            'Owner Authorization Required',
            'Only the Server Owner or holders of the configured owner role can execute `/challenge` commands.',
          ),
        ],
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (subcommand === 'verify') {
      const enabled = interaction.options.getBoolean('enabled', true);
      this.challengeController.setVerificationEnabled(enabled);
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
            'This stage promotion prompt has expired. Please run `/challenge advance` again.',
          ),
        ],
        components: [],
      });
      return;
    }

    this.pendingAdvances.delete(token);
    await interaction.deferUpdate();

    const candidates = this.challengeController.resolveCandidatesForAdvance(pending.fromStage);
    const result = await this.challengeController.advanceStudentsToStage(
      interaction.guild,
      candidates,
      pending.toStage,
    );

    await interaction.editReply({
      embeds: [
        EmbedFactory.buildBatchMutationEmbed(
          'Stage Advancement Complete',
          `Promoted eligible students from \`${pending.fromStage}\` to \`${pending.toStage}\`.`,
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
            EmbedFactory.buildErrorEmbed(
              'Session Expired',
              'Please run `/challenge advance` again.',
            ),
          ],
          components: [],
        });
        return;
      }

      this.pendingAdvances.delete(token);
      await interaction.deferUpdate();

      const excludeMentionString = selectedDiscordIds.map((id) => `<@${id}>`).join(' ');
      const candidates = this.challengeController.resolveCandidatesForAdvance(
        pending.fromStage,
        excludeMentionString,
        null,
      );
      const result = await this.challengeController.advanceStudentsToStage(
        interaction.guild,
        candidates,
        pending.toStage,
      );

      await interaction.editReply({
        embeds: [
          EmbedFactory.buildBatchMutationEmbed(
            'Stage Advancement Complete',
            `Promoted students from \`${pending.fromStage}\` to \`${pending.toStage}\` excluding \`${selectedDiscordIds.length}\` selected member(s).`,
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
            EmbedFactory.buildErrorEmbed(
              'Session Expired',
              'Please run `/challenge revoke` again.',
            ),
          ],
          components: [],
        });
        return;
      }

      this.pendingRevokes.delete(token);
      await interaction.deferUpdate();

      const result = await this.challengeController.revokeStageRoleFromTargets(
        interaction.guild,
        pending.stage,
        selectedDiscordIds,
        [],
      );

      await interaction.editReply({
        embeds: [
          EmbedFactory.buildBatchMutationEmbed(
            'Stage Role Revoked',
            `Removed \`${pending.stage}\` from selected members.`,
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
   * Processes /challenge advance inline or opens the interactive multi-user exclusion prompt.
   *
   * @param interaction the slash command interaction
   */
  private async handleAdvanceCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
      return;
    }

    const fromStage = interaction.options.getString('from', true) as 'challenge-1' | 'challenge-2';
    const rawToStage = interaction.options.getString('to') as 'challenge-2' | 'challenge-3' | null;
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

    const targetStage = this.challengeController.resolveTargetStage(fromStage, rawToStage);
    if (!targetStage) {
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            'Invalid Stage Progression',
            `Cannot advance from \`${fromStage}\` to \`${rawToStage ?? 'unknown'}\`.`,
          ),
        ],
      });
      return;
    }

    if (excludeInput || onlyInput) {
      const candidates = this.challengeController.resolveCandidatesForAdvance(
        fromStage,
        excludeInput,
        onlyInput,
      );
      const result = await this.challengeController.advanceStudentsToStage(
        interaction.guild,
        candidates,
        targetStage,
      );

      await interaction.editReply({
        embeds: [
          EmbedFactory.buildBatchMutationEmbed(
            'Stage Advancement Complete',
            `Promoted filtered students from \`${fromStage}\` to \`${targetStage}\`.`,
            result,
          ),
        ],
      });
      return;
    }

    const allEligible = this.challengeController.resolveCandidatesForAdvance(fromStage);
    if (allEligible.length === 0) {
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildWarningEmbed(
            'No Eligible Candidates',
            `No verified students currently hold \`${fromStage}\`.`,
          ),
        ],
      });
      return;
    }

    this.pruneExpiredSessions();
    const token = `${interaction.user.id}-${Date.now()}`;
    this.pendingAdvances.set(token, {
      ownerId: interaction.user.id,
      fromStage,
      toStage: targetStage,
      expiresAtMs: Date.now() + ChallengeCommandView.SESSION_TTL_MS,
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
          'Confirm Stage Advancement',
          `Ready to advance \`${allEligible.length}\` student(s) from \`${fromStage}\` to \`${targetStage}\`.\n\nUse the user selector below to exclude dropped or eliminated candidates, or click the button to advance everyone.`,
        ),
      ],
      components: [
        new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(excludeSelect),
        new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton),
      ],
    });
  }

  /**
   * Processes /challenge revoke inline or opens the multi-user picker.
   *
   * @param interaction the slash command interaction
   */
  private async handleRevokeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
      return;
    }

    const stage = interaction.options.getString('role', true) as ChallengeStageKey;
    const usersInput = interaction.options.getString('users');

    if (usersInput && usersInput.trim().length > 0) {
      const tokens = InputValidator.parseTargetTokens(usersInput);
      const result = await this.challengeController.revokeStageRoleFromTargets(
        interaction.guild,
        stage,
        tokens.discordIds,
        tokens.studentIds,
      );
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildBatchMutationEmbed(
            'Stage Role Revoked',
            `Removed \`${stage}\` from specified targets.`,
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
      stage,
      expiresAtMs: Date.now() + ChallengeCommandView.SESSION_TTL_MS,
    });

    const userSelect = new UserSelectMenuBuilder()
      .setCustomId(`${REVOKE_SELECT_PREFIX}${token}`)
      .setPlaceholder(`Select up to 25 members to remove ${stage} from`)
      .setMinValues(1)
      .setMaxValues(25);

    await interaction.editReply({
      embeds: [
        EmbedFactory.buildInfoEmbed(
          'Select Members to Revoke',
          `Choose one or more members below to remove \`${stage}\` from both Discord and SQLite.`,
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
