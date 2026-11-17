import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  type Guild,
  SlashCommandBuilder,
  UserSelectMenuBuilder,
  type UserSelectMenuInteraction,
} from "discord.js";
import type {
  RoundController,
  StageKey,
} from "../controller/RoundController.js";
import type { RoundKey, Student } from "../model/Student.js";
import type { GuildResourceResolver } from "../util/GuildResourceResolver.js";
import { Logger } from "../util/Logger.js";
import { EmbedFactory } from "./EmbedFactory.js";
import { resolveInteractionMember } from "./StudentModalBuilder.js";

/**
 * Custom identifier prefix for confirming a /round promote or /round revoke operation.
 */
const ROUND_CONFIRM_PREFIX = "fcode-round-confirm:";

/**
 * Custom identifier prefix for cancelling a pending /round operation.
 */
const ROUND_CANCEL_PREFIX = "fcode-round-cancel:";

/**
 * Custom identifier prefix for excluding members before executing /round promote or /round revoke.
 */
const ROUND_EXCLUDE_SELECT_PREFIX = "fcode-round-exclude:";

/**
 * Pending interactive confirmation state for /round promote or /round revoke.
 */
type PendingRoundOperation =
  | {
      kind: "PROMOTE";
      ownerId: string;
      fromStage: StageKey;
      toStage: StageKey;
      excludeInput: string | null;
      onlyInput: string | null;
      excludedCount: number;
      expiresAtMs: number;
    }
  | {
      kind: "REVOKE";
      ownerId: string;
      rounds: RoundKey[];
      excludeInput: string | null;
      onlyInput: string | null;
      excludedCount: number;
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
  public constructor(
    roundController: RoundController,
    resourceResolver: GuildResourceResolver,
  ) {
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
      { name: "verified", value: "verified" },
      { name: "round-1", value: "round-1" },
      { name: "round-2", value: "round-2" },
      { name: "round-3", value: "round-3" },
    ];

    const roundChoices = [
      { name: "round-1", value: "round-1" },
      { name: "round-2", value: "round-2" },
      { name: "round-3", value: "round-3" },
    ];

    return new SlashCommandBuilder()
      .setName("round")
      .setDescription(
        "Manage recruitment round promotions and revocations (owner only).",
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("promote")
          .setDescription(
            "Transition students from one recruitment stage to another.",
          )
          .addStringOption((option) =>
            option
              .setName("from")
              .setDescription("Source stage.")
              .setRequired(true)
              .addChoices(...stageChoices),
          )
          .addStringOption((option) =>
            option
              .setName("to")
              .setDescription("Target stage.")
              .setRequired(true)
              .addChoices(...stageChoices),
          )
          .addStringOption((option) =>
            option
              .setName("exclude")
              .setDescription("Optional @mentions or student IDs to exclude.")
              .setRequired(false),
          )
          .addStringOption((option) =>
            option
              .setName("only")
              .setDescription(
                "Optional @mentions or student IDs to include exclusively.",
              )
              .setRequired(false),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("revoke")
          .setDescription(
            "Bulk remove one or more round roles from eligible members.",
          )
          .addStringOption((option) =>
            option
              .setName("round")
              .setDescription("Primary round role to remove.")
              .setRequired(true)
              .addChoices(...roundChoices),
          )
          .addStringOption((option) =>
            option
              .setName("second-round")
              .setDescription("Optional second round role to remove.")
              .setRequired(false)
              .addChoices(...roundChoices),
          )
          .addStringOption((option) =>
            option
              .setName("third-round")
              .setDescription("Optional third round role to remove.")
              .setRequired(false)
              .addChoices(...roundChoices),
          )
          .addStringOption((option) =>
            option
              .setName("exclude")
              .setDescription("Optional @mentions or student IDs to exclude.")
              .setRequired(false),
          )
          .addStringOption((option) =>
            option
              .setName("only")
              .setDescription(
                "Optional @mentions or student IDs to include exclusively.",
              )
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
            "Only the Server Owner or holders of the configured owner role can execute `/round` commands.",
          ),
        ],
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "promote") {
      await this.handlePromoteCommand(interaction);
      return;
    }
    if (subcommand === "revoke") {
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
      await this.handleCancelButton(interaction);
      return;
    }

    if (!interaction.customId.startsWith(ROUND_CONFIRM_PREFIX)) {
      return;
    }

    const token = interaction.customId.slice(ROUND_CONFIRM_PREFIX.length);
    const pending = this.getValidPendingSession(token, interaction.user.id);
    if (!pending) {
      await this.renderExpiredSession(interaction);
      return;
    }

    this.pendingOperations.delete(token);
    await interaction.deferUpdate();
    await this.executePendingOperation(interaction, interaction.guild, pending);
  }

  /**
   * Updates pending exclusion filters when members are selected in the UserSelectMenu.
   *
   * @param interaction the Discord user select menu interaction
   */
  public async handleUserSelectMenu(
    interaction: UserSelectMenuInteraction,
  ): Promise<void> {
    if (
      !interaction.guild ||
      !interaction.customId.startsWith(ROUND_EXCLUDE_SELECT_PREFIX)
    ) {
      return;
    }

    const token = interaction.customId.slice(
      ROUND_EXCLUDE_SELECT_PREFIX.length,
    );
    const pending = this.getValidPendingSession(token, interaction.user.id);
    if (!pending) {
      await this.renderExpiredSession(interaction);
      return;
    }

    const selectedDiscordIds = Array.from(interaction.users.keys());
    pending.excludeInput = selectedDiscordIds.map((id) => `<@${id}>`).join(" ");
    pending.excludedCount = selectedDiscordIds.length;
    pending.expiresAtMs = Date.now() + RoundCommandView.SESSION_TTL_MS;

    const candidates = this.resolveCandidatesForPending(pending);
    if (candidates.length === 0) {
      this.pendingOperations.delete(token);
      await interaction.update({
        embeds: [
          EmbedFactory.buildWarningEmbed(
            "No Eligible Candidates",
            "All eligible students were excluded by your selection. No changes were applied.",
          ),
        ],
        components: [],
      });
      return;
    }

    await interaction.update({
      embeds: [this.buildConfirmationEmbed(pending, candidates.length)],
      components: this.buildConfirmationComponents(
        token,
        pending,
        candidates.length,
        true,
      ),
    });
  }

  /**
   * Handles cancellation of a pending /round confirmation prompt.
   *
   * @param interaction the Cancel button interaction
   */
  private async handleCancelButton(
    interaction: ButtonInteraction,
  ): Promise<void> {
    const token = interaction.customId.slice(ROUND_CANCEL_PREFIX.length);
    const pending = this.pendingOperations.get(token);
    if (pending?.ownerId !== interaction.user.id) {
      await interaction.reply({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            "Unauthorized or Expired",
            "Only the command invoker can cancel this pending operation.",
          ),
        ],
      });
      return;
    }

    this.pendingOperations.delete(token);
    await interaction.update({
      embeds: [
        EmbedFactory.buildWarningEmbed(
          "Operation Cancelled",
          "The pending `/round` operation was cancelled. No roles or records were modified.",
        ),
      ],
      components: [],
    });
  }

  /**
   * Executes a confirmed PROMOTE or REVOKE operation and updates the prompt with results.
   *
   * @param interaction the Confirm button interaction
   * @param guild the target Discord guild
   * @param pending the validated pending operation state
   */
  private async executePendingOperation(
    interaction: ButtonInteraction,
    guild: Guild,
    pending: PendingRoundOperation,
  ): Promise<void> {
    const candidates = this.resolveCandidatesForPending(pending);

    if (pending.kind === "PROMOTE") {
      const result = await this.roundController.transitionStudents(
        guild,
        candidates,
        pending.toStage,
        pending.fromStage,
      );
      Logger.info("RoundCommandView", "Completed round promote operation", {
        callerId: interaction.user.id,
        fromStage: pending.fromStage,
        toStage: pending.toStage,
        excludedCount: pending.excludedCount,
        updatedCount: result.updatedCount,
        failedCount: result.failedMembers.length,
      });

      const excludeNote =
        pending.excludedCount > 0
          ? ` excluding \`${String(pending.excludedCount)}\` selected member(s)`
          : "";
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildBatchMutationEmbed(
            "Round Transition Complete",
            `Transitioned eligible students from \`${pending.fromStage}\` to \`${pending.toStage}\`${excludeNote}.`,
            result,
          ),
        ],
        components: [],
      });
      return;
    }

    const result = await this.roundController.revokeRoundsFromCandidates(
      guild,
      candidates,
      pending.rounds,
    );
    const roundsLabel = pending.rounds.join(", ");
    Logger.info("RoundCommandView", "Completed round revoke operation", {
      callerId: interaction.user.id,
      rounds: pending.rounds,
      excludedCount: pending.excludedCount,
      updatedCount: result.updatedCount,
      failedCount: result.failedMembers.length,
    });

    const excludeNote =
      pending.excludedCount > 0
        ? ` excluding \`${String(pending.excludedCount)}\` selected member(s)`
        : "";
    await interaction.editReply({
      embeds: [
        EmbedFactory.buildBatchMutationEmbed(
          "Round Roles Revoked",
          `Removed \`${roundsLabel}\` from eligible members${excludeNote}.`,
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
  private async handlePromoteCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const fromStage = interaction.options.getString("from", true) as StageKey;
    const toStage = interaction.options.getString("to", true) as StageKey;
    const excludeInput = interaction.options.getString("exclude");
    const onlyInput = interaction.options.getString("only");

    if (excludeInput && onlyInput) {
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            "Conflicting Filters",
            "Specify either `exclude` or `only`, never both at the same time.",
          ),
        ],
      });
      return;
    }

    if (fromStage === toStage) {
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            "Invalid Transition",
            "`from` and `to` must be different stages.",
          ),
        ],
      });
      return;
    }

    const candidates = this.roundController.resolveCandidates(
      fromStage,
      excludeInput,
      onlyInput,
    );
    if (candidates.length === 0) {
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildWarningEmbed(
            "No Eligible Candidates",
            `No verified students matched \`${fromStage}\` with the provided filters.`,
          ),
        ],
      });
      return;
    }

    this.pruneExpiredSessions();
    const token = `${interaction.user.id}-${String(Date.now())}`;
    const pending: PendingRoundOperation = {
      kind: "PROMOTE",
      ownerId: interaction.user.id,
      fromStage,
      toStage,
      excludeInput,
      onlyInput,
      excludedCount: 0,
      expiresAtMs: Date.now() + RoundCommandView.SESSION_TTL_MS,
    };
    this.pendingOperations.set(token, pending);

    await interaction.editReply({
      embeds: [this.buildConfirmationEmbed(pending, candidates.length)],
      components: this.buildConfirmationComponents(
        token,
        pending,
        candidates.length,
        !excludeInput && !onlyInput,
      ),
    });
  }

  /**
   * Validates /round revoke arguments and displays a mandatory confirmation prompt.
   *
   * @param interaction the slash command interaction
   */
  private async handleRevokeCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const firstRound = interaction.options.getString("round", true) as RoundKey;
    const secondRound = interaction.options.getString(
      "second-round",
    ) as RoundKey | null;
    const thirdRound = interaction.options.getString(
      "third-round",
    ) as RoundKey | null;
    const rounds = Array.from(
      new Set<RoundKey>([
        firstRound,
        ...(secondRound ? [secondRound] : []),
        ...(thirdRound ? [thirdRound] : []),
      ]),
    );
    const excludeInput = interaction.options.getString("exclude");
    const onlyInput = interaction.options.getString("only");

    if (excludeInput && onlyInput) {
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildErrorEmbed(
            "Conflicting Filters",
            "Specify either `exclude` or `only`, never both at the same time.",
          ),
        ],
      });
      return;
    }

    const candidates = this.roundController.resolveCandidatesForRounds(
      rounds,
      excludeInput,
      onlyInput,
    );
    if (candidates.length === 0) {
      await interaction.editReply({
        embeds: [
          EmbedFactory.buildWarningEmbed(
            "No Eligible Candidates",
            `No verified students currently hold \`${rounds.join(", ")}\` with the provided filters.`,
          ),
        ],
      });
      return;
    }

    this.pruneExpiredSessions();
    const token = `${interaction.user.id}-${String(Date.now())}`;
    const pending: PendingRoundOperation = {
      kind: "REVOKE",
      ownerId: interaction.user.id,
      rounds,
      excludeInput,
      onlyInput,
      excludedCount: 0,
      expiresAtMs: Date.now() + RoundCommandView.SESSION_TTL_MS,
    };
    this.pendingOperations.set(token, pending);

    await interaction.editReply({
      embeds: [this.buildConfirmationEmbed(pending, candidates.length)],
      components: this.buildConfirmationComponents(
        token,
        pending,
        candidates.length,
        !excludeInput && !onlyInput,
      ),
    });
  }

  /**
   * Resolves candidates matching a pending PROMOTE or REVOKE session.
   *
   * @param pending the pending operation state
   * @returns filtered Student array
   */
  private resolveCandidatesForPending(
    pending: PendingRoundOperation,
  ): Student[] {
    if (pending.kind === "PROMOTE") {
      return this.roundController.resolveCandidates(
        pending.fromStage,
        pending.excludeInput,
        pending.onlyInput,
      );
    }
    return this.roundController.resolveCandidatesForRounds(
      pending.rounds,
      pending.excludeInput,
      pending.onlyInput,
    );
  }

  /**
   * Builds the confirmation embed reflecting the current target count and any selected exclusions.
   *
   * @param pending the pending operation state
   * @param candidateCount number of students affected
   * @returns configured EmbedBuilder instance
   */
  private buildConfirmationEmbed(
    pending: PendingRoundOperation,
    candidateCount: number,
  ): EmbedBuilder {
    const excludeLine =
      pending.excludedCount > 0
        ? `\nExcluded via menu: \`${String(pending.excludedCount)}\` member(s).`
        : "";

    if (pending.kind === "PROMOTE") {
      return EmbedFactory.buildInfoEmbed(
        "Confirm Round Transition",
        `Ready to transition \`${String(candidateCount)}\` student(s) from \`${pending.fromStage}\` to \`${pending.toStage}\`.${excludeLine}\n\nClick **Confirm** to apply changes to Discord and SQLite, or **Cancel** to abort.`,
      );
    }

    return EmbedFactory.buildInfoEmbed(
      "Confirm Round Revocation",
      `Ready to remove \`${pending.rounds.join(", ")}\` from \`${String(candidateCount)}\` student(s).${excludeLine}\n\nClick **Confirm** to apply changes to Discord and SQLite, or **Cancel** to abort.`,
    );
  }

  /**
   * Builds the confirmation action rows including optional UserSelectMenu and Confirm/Cancel buttons.
   *
   * @param token session token
   * @param pending the pending operation state
   * @param candidateCount current affected student count
   * @param includeExcludeSelect whether to include the UserSelectMenu
   * @returns array of Discord ActionRowBuilder instances
   */
  private buildConfirmationComponents(
    token: string,
    pending: PendingRoundOperation,
    candidateCount: number,
    includeExcludeSelect: boolean,
  ): (
    ActionRowBuilder<UserSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>
  )[] {
    const components: (
      ActionRowBuilder<UserSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>
    )[] = [];

    if (includeExcludeSelect) {
      const excludeSelect = new UserSelectMenuBuilder()
        .setCustomId(`${ROUND_EXCLUDE_SELECT_PREFIX}${token}`)
        .setPlaceholder("Optional: select members to EXCLUDE before confirming")
        .setMinValues(0)
        .setMaxValues(25);
      components.push(
        new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
          excludeSelect,
        ),
      );
    }

    const confirmButton = new ButtonBuilder()
      .setCustomId(`${ROUND_CONFIRM_PREFIX}${token}`)
      .setLabel(
        pending.kind === "PROMOTE"
          ? `Confirm Transition (${String(candidateCount)})`
          : `Confirm Revoke (${String(candidateCount)})`,
      )
      .setStyle(
        pending.kind === "PROMOTE" ? ButtonStyle.Success : ButtonStyle.Danger,
      );
    const cancelButton = new ButtonBuilder()
      .setCustomId(`${ROUND_CANCEL_PREFIX}${token}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary);

    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        confirmButton,
        cancelButton,
      ),
    );
    return components;
  }

  /**
   * Retrieves a pending operation if it belongs to callerId and has not expired.
   *
   * @param token the session token
   * @param callerId the interacting Discord user ID
   * @returns the PendingRoundOperation or null when invalid or expired
   */
  private getValidPendingSession(
    token: string,
    callerId: string,
  ): PendingRoundOperation | null {
    const pending = this.pendingOperations.get(token);
    if (pending?.ownerId !== callerId || pending.expiresAtMs < Date.now()) {
      return null;
    }
    return pending;
  }

  /**
   * Renders an expired session notice and clears interactive components.
   *
   * @param interaction the button or select menu interaction
   */
  private async renderExpiredSession(
    interaction: ButtonInteraction | UserSelectMenuInteraction,
  ): Promise<void> {
    await interaction.update({
      embeds: [
        EmbedFactory.buildErrorEmbed(
          "Session Expired",
          "This confirmation prompt has expired. Please run the `/round` command again.",
        ),
      ],
      components: [],
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
