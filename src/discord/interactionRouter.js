import { MessageFlags } from 'discord.js';
import { parseId } from './customId.js';

// Dispatches interactions to registered handlers: slash commands by name,
// buttons/selects and modals by the first segment of their ttdb customId.
// Handler signature: (ctx, interaction, parts) — parts are the customId
// segments after the action.
export function createRouter(ctx) {
  const commands = new Map();
  const components = new Map();
  const modals = new Map();

  async function dispatch(interaction) {
    try {
      if (interaction.isChatInputCommand?.()) {
        const handler = commands.get(interaction.commandName);
        if (handler) await handler(ctx, interaction);
        return;
      }
      const isComponent = interaction.isButton?.() || interaction.isAnySelectMenu?.();
      const isModal = interaction.isModalSubmit?.();
      if (!isComponent && !isModal) return;
      const parts = parseId(interaction.customId);
      if (!parts) return;
      const handler = (isModal ? modals : components).get(parts[0]);
      if (handler) await handler(ctx, interaction, parts.slice(1));
    } catch (err) {
      console.error('[ttdb] interaction handler failed:', err);
      const payload = {
        content: '⚠️ Something went wrong — the details were logged on the bot host.',
        flags: MessageFlags.Ephemeral,
      };
      try {
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
      } catch {
        // interaction expired or already acknowledged; nothing more to do
      }
    }
  }

  return {
    command: (name, handler) => commands.set(name, handler),
    component: (action, handler) => components.set(action, handler),
    modal: (action, handler) => modals.set(action, handler),
    dispatch,
  };
}
