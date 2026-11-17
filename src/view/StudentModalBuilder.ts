import {
  type APIInteractionGuildMember,
  type Guild,
  GuildMember,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

/**
 * Resolves a GuildMember from an interaction payload or guild cache before falling back to REST fetch.
 *
 * @param guild the target Discord guild
 * @param interactionMember the raw interaction member object if present
 * @param userId the Discord user snowflake ID
 * @returns the resolved GuildMember instance
 */
export async function resolveInteractionMember(
  guild: Guild,
  interactionMember: GuildMember | APIInteractionGuildMember | null,
  userId: string,
): Promise<GuildMember> {
  if (interactionMember instanceof GuildMember) {
    return interactionMember;
  }
  const cached = guild.members.cache.get(userId);
  if (cached) {
    return cached;
  }
  return await guild.members.fetch(userId);
}

/**
 * Builds the standardized two-field Discord Modal requesting full name and student ID.
 *
 * @param customId the modal custom identifier
 * @param title the modal dialog title
 * @param latestCohort two-digit cohort code used in the Student ID placeholder
 * @returns a configured ModalBuilder instance
 */
export function buildStudentInputModal(
  customId: string,
  title: string,
  latestCohort: string,
): ModalBuilder {
  const fullNameInput = new TextInputBuilder()
    .setCustomId("full-name-input")
    .setPlaceholder("Example: Nguyễn Văn A")
    .setStyle(TextInputStyle.Short)
    .setMinLength(2)
    .setMaxLength(60)
    .setRequired(true);

  const studentIdInput = new TextInputBuilder()
    .setCustomId("student-id-input")
    .setPlaceholder(`Example: SE${latestCohort}0001`)
    .setStyle(TextInputStyle.Short)
    .setMinLength(8)
    .setMaxLength(8)
    .setRequired(true);

  const fullNameLabel = new LabelBuilder()
    .setLabel("Full Name")
    .setTextInputComponent(fullNameInput);

  const studentIdLabel = new LabelBuilder()
    .setLabel("Student ID (8 characters)")
    .setTextInputComponent(studentIdInput);

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addLabelComponents(fullNameLabel, studentIdLabel);
}
