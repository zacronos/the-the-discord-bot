import { Client, GatewayIntentBits } from 'discord.js';

// GuildMembers (privileged) is required to know who has and hasn't voted.
export function createClient() {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });
}
