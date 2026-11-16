import { Colors, EmbedBuilder } from 'discord.js';
import type { BatchRoleMutationResult } from '../model/Student.js';

/**
 * Builds a green success embed with consistent footer branding.
 *
 * @param title the embed heading
 * @param description the primary body content
 * @returns a configured EmbedBuilder instance
 */
function buildSuccessEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: 'F-Code Operator Bot' })
    .setTimestamp();
}

/**
 * Builds a gold warning embed for non-fatal constraints or hierarchy notices.
 *
 * @param title the embed heading
 * @param description the primary body content
 * @returns a configured EmbedBuilder instance
 */
function buildWarningEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: 'F-Code Operator Bot' })
    .setTimestamp();
}

/**
 * Builds a red error embed for rejected inputs, conflicts, or denied permissions.
 *
 * @param title the embed heading
 * @param description the primary error explanation
 * @returns a configured EmbedBuilder instance
 */
function buildErrorEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: 'F-Code Operator Bot' })
    .setTimestamp();
}

/**
 * Builds a blue informational embed for interactive prompts and lookups.
 *
 * @param title the embed heading
 * @param description the primary informational text
 * @returns a configured EmbedBuilder instance
 */
function buildInfoEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: 'F-Code Operator Bot' })
    .setTimestamp();
}

/**
 * Formats a BatchRoleMutationResult summary into a standardized success or warning embed.
 *
 * @param title the summary embed title
 * @param actionSummary a short sentence describing the completed operation
 * @param result the batch execution counts and failures
 * @returns a configured EmbedBuilder summarizing the batch result
 */
function buildBatchMutationEmbed(
  title: string,
  actionSummary: string,
  result: BatchRoleMutationResult,
): EmbedBuilder {
  const baseLines = [
    actionSummary,
    '',
    `Targeted: \`${result.targetedCount}\``,
    `Updated: \`${result.updatedCount}\``,
    `Skipped (Already Unchanged): \`${result.skippedCount}\``,
    `Failed: \`${result.failedMembers.length}\``,
  ];

  if (result.failedMembers.length > 0) {
    const preview = result.failedMembers.slice(0, 15).join(', ');
    baseLines.push('', `Failed Targets: ${preview}`);
    return buildWarningEmbed(title, baseLines.join('\n'));
  }

  return buildSuccessEmbed(title, baseLines.join('\n'));
}

/**
 * Constructs standardized Discord embeds for verification, student, and round views.
 */
export const EmbedFactory = {
  buildSuccessEmbed,
  buildWarningEmbed,
  buildErrorEmbed,
  buildInfoEmbed,
  buildBatchMutationEmbed,
} as const;
