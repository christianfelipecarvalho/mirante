/**
 * An icon per agent.
 *
 * Deliberately monochrome geometry rather than emoji. An emoji carries its own
 * colour from the font, which overrides the identity colour the lane assigns —
 * so every agent ends up looking alike and the colour channel is wasted. These
 * glyphs inherit `color`, letting shape carry the role and colour carry the
 * individual.
 *
 * Preference order: a user-supplied map, then the agent's own type, then
 * something deterministic. Deterministic matters more than it sounds — an agent
 * that changes glyph between renders is worse than a dull one, because the board
 * is read by glancing.
 */
const FALLBACK_GLYPHS = ['◆', '●', '▲', '■', '★', '⬟', '◐', '❖', '⬢', '✶', '◈', '▼'] as const;

const KNOWN: Record<string, string> = {
  main: '⌂',
  explore: '⌕',
  search: '⌕',
  plan: '◇',
  general: '◆',
  'general-purpose': '◆',
  claude: '◆',
  review: '◉',
  security: '⬟',
  audit: '⬟',
  test: '◈',
  qa: '◈',
  docs: '▤',
  doc: '▤',
  write: '▤',
  frontend: '▧',
  web: '▧',
  ui: '▧',
  backend: '▨',
  api: '▨',
  data: '▦',
  build: '⬢',
  deploy: '⬢',
};

/**
 * Longest needle first, so `review-frontend` reads as frontend rather than as
 * review. A fleet of `review-*` agents that all share one glyph tells you
 * nothing about which is which.
 */
const NEEDLES = Object.keys(KNOWN)
  .filter((needle) => needle.length > 2)
  .sort((a, b) => b.length - a.length);

const hash = (value: string): number => {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
};

/** An agent we only ever saw finish: honest about being unidentified. */
export const UNKNOWN_GLYPH = '◌';

export const agentIcon = (
  agentType: string | undefined,
  agentId: string,
  overrides: Record<string, string> = {},
): string => {
  // Hashing an opaque id into a glyph would imply an identity Mirante does not
  // have. A placeholder says what is true: this one is unidentified.
  if (!agentType && agentId !== 'main') return UNKNOWN_GLYPH;
  const key = (agentType ?? agentId).toLowerCase();
  if (overrides[key]) return overrides[key] as string;
  if (KNOWN[key]) return KNOWN[key] as string;
  for (const needle of NEEDLES) {
    if (key.includes(needle)) return KNOWN[needle] as string;
  }
  return FALLBACK_GLYPHS[hash(key) % FALLBACK_GLYPHS.length] as string;
};

export const agentLabel = (agentType: string | undefined, agentId: string): string => {
  if (agentId === 'main') return 'Session';
  return agentType ?? agentId.slice(0, 8);
};
