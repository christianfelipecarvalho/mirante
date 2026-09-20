/**
 * An icon per agent.
 *
 * Preference order, per the product brief: a user-supplied map, then the agent's
 * own frontmatter, then something deterministic. Deterministic matters more than
 * it sounds — an agent that changes glyph between renders is worse than a dull
 * one, because the board is read by glancing.
 */
const FALLBACK_GLYPHS = ['◆', '●', '▲', '■', '★', '⬟', '◐', '❖', '⬢', '✶', '◈', '▼'] as const;

const KNOWN: Record<string, string> = {
  main: '⌂',
  explore: '🔍',
  plan: '🗺',
  general: '◆',
  'general-purpose': '◆',
  review: '🔎',
  security: '🛡',
  test: '🧪',
  docs: '📄',
  frontend: '🖼',
  backend: '⚙',
  qa: '✓',
  build: '🔨',
  claude: '◆',
};

const hash = (value: string): number => {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
};

export const agentIcon = (
  agentType: string | undefined,
  agentId: string,
  overrides: Record<string, string> = {},
): string => {
  const key = (agentType ?? agentId).toLowerCase();
  if (overrides[key]) return overrides[key] as string;
  if (KNOWN[key]) return KNOWN[key] as string;
  for (const [needle, glyph] of Object.entries(KNOWN)) {
    if (needle.length > 3 && key.includes(needle)) return glyph;
  }
  return FALLBACK_GLYPHS[hash(key) % FALLBACK_GLYPHS.length] as string;
};

export const agentLabel = (agentType: string | undefined, agentId: string): string => {
  if (agentId === 'main') return 'Session';
  return agentType ?? agentId.slice(0, 8);
};
