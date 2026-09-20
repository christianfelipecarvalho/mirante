import type { IconName } from './icon-set.js';

/**
 * An icon per agent, chosen for what the agent does.
 *
 * Icons carry the role, and the lane's colour carries the individual — so a
 * fleet of review-* agents is told apart by colour and number, while a security
 * reviewer still looks like security work at a glance.
 *
 * Deterministic matters more than it sounds: an agent that changes mark between
 * renders is worse than a dull one, because the board is read by glancing.
 */
const FALLBACK: readonly IconName[] = ['agent', 'box', 'layout', 'server', 'beaker', 'map'];

const BY_ROLE: Record<string, IconName> = {
  main: 'session',
  explore: 'search',
  search: 'search',
  plan: 'map',
  general: 'agent',
  'general-purpose': 'agent',
  claude: 'agent',
  review: 'check',
  security: 'shield',
  audit: 'shield',
  test: 'beaker',
  qa: 'beaker',
  docs: 'file',
  doc: 'file',
  write: 'pencil',
  frontend: 'layout',
  web: 'layout',
  ui: 'layout',
  backend: 'server',
  api: 'server',
  data: 'server',
  build: 'box',
  deploy: 'box',
  guide: 'guide',
};

/**
 * How specific a role word is.
 *
 * `review-frontend` matches both "review" and "frontend"; the domain is what
 * distinguishes it from its siblings, so the domain wins. Matching runs over
 * hyphen-delimited segments rather than raw substrings — "qa" inside "quality"
 * is a coincidence, "qa" as a segment is a claim.
 */
const SPECIFICITY: Record<string, number> = {
  general: 0,
  'general-purpose': 0,
  claude: 0,
  main: 0,
  review: 1,
  audit: 1,
  write: 1,
  doc: 1,
  web: 1,
  api: 1,
  data: 1,
  search: 2,
  explore: 2,
  plan: 2,
  test: 2,
  qa: 2,
  docs: 2,
  build: 2,
  deploy: 2,
  guide: 2,
  security: 3,
  frontend: 3,
  backend: 3,
  ui: 3,
};

const segmentsOf = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[-_\s.]+/)
    .filter(Boolean);

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
  overrides: Record<string, IconName> = {},
): IconName => {
  if (agentId === 'main') return 'session';
  // No type at all means the agent was already running before Mirante saw it.
  // Inventing a mark would imply an identity it does not have.
  if (!agentType) return 'unknown';

  const key = agentType.toLowerCase();
  if (overrides[key]) return overrides[key] as IconName;
  if (BY_ROLE[key]) return BY_ROLE[key] as IconName;

  let best: { icon: IconName; rank: number } | undefined;
  for (const segment of segmentsOf(key)) {
    // A segment can also be an inflection: "reviewer" is a review.
    const role = BY_ROLE[segment]
      ? segment
      : Object.keys(BY_ROLE).find((needle) => needle.length > 3 && segment.startsWith(needle));
    if (!role) continue;
    const rank = SPECIFICITY[role] ?? 1;
    if (!best || rank > best.rank) best = { icon: BY_ROLE[role] as IconName, rank };
  }
  if (best) return best.icon;

  return FALLBACK[hash(key) % FALLBACK.length] as IconName;
};

export const agentLabel = (agentType: string | undefined, agentId: string): string => {
  if (agentId === 'main') return 'Session';
  return agentType ?? agentId.slice(0, 8);
};
