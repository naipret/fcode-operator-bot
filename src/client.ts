import { Client, GatewayIntentBits, Options } from 'discord.js';

/**
 * Creates a configured Discord.js client with balanced memory caches.
 *
 * @returns an unauthenticated Discord Client instance
 */
export function createDiscordClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 50,
      ReactionManager: 0,
      ReactionUserManager: 0,
      GuildEmojiManager: 0,
      GuildStickerManager: 0,
      PresenceManager: 0,
      VoiceStateManager: 0,
      GuildScheduledEventManager: 0,
      AutoModerationRuleManager: 0,
    }),
  });
}
