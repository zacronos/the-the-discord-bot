// customId codec: every component/modal id is `ttdb:<action>[:<part>...]`.
const PREFIX = 'ttdb';

export function buildId(...parts) {
  const id = [PREFIX, ...parts].join(':');
  if (id.length > 100) throw new Error(`customId exceeds Discord's 100-char limit: ${id.length}`);
  return id;
}

// Returns [action, ...parts] for our ids, null for anything else.
export function parseId(customId) {
  if (typeof customId !== 'string') return null;
  const parts = customId.split(':');
  if (parts[0] !== PREFIX || parts.length < 2) return null;
  return parts.slice(1);
}
