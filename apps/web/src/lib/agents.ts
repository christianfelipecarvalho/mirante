import type { AgentCard } from '@mirante/shared';

/**
 * Built-in agent types, and the i18n key describing what each one is for.
 *
 * "general-purpose" tells you nothing about whether you are looking at the
 * window you type into or something it spawned, which is exactly the question a
 * board like this exists to answer.
 */
const ROLE_KEYS: Record<string, string> = {
  'general-purpose': 'role.general',
  claude: 'role.general',
  explore: 'role.explore',
  Explore: 'role.explore',
  plan: 'role.plan',
  Plan: 'role.plan',
  'statusline-setup': 'role.setup',
  'claude-code-guide': 'role.guide',
};

export const agentRoleKey = (card: Pick<AgentCard, 'agentId' | 'agentType'>): string => {
  if (card.agentId === 'main') return 'role.session';
  const type = card.agentType ?? '';
  return ROLE_KEYS[type] ?? 'role.custom';
};

/**
 * A position among agents that share a type.
 *
 * Three cards all reading "general-purpose" are impossible to tell apart or
 * refer to. Returns undefined when the type appears once, so a lone agent does
 * not carry a pointless "#1".
 */
export const agentOrdinals = (cards: readonly AgentCard[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const card of cards) {
    if (card.agentId === 'main') continue;
    const type = card.agentType ?? card.agentId;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  const ordinals = new Map<string, number>();
  for (const card of cards) {
    if (card.agentId === 'main') continue;
    const type = card.agentType ?? card.agentId;
    if ((counts.get(type) ?? 0) < 2) continue;
    const next = (seen.get(type) ?? 0) + 1;
    seen.set(type, next);
    ordinals.set(card.agentId, next);
  }
  return ordinals;
};

/**
 * A definition read from `.claude/agents/*.md`, as the daemon serves it.
 */
export type AgentDefinition = {
  name: string;
  description?: string;
  color?: string;
  model?: string;
  scope: 'project' | 'user';
};

/**
 * Claude Code's named agent colours, mapped onto the themed slots.
 *
 * An author who picked "purple" gets purple on both surfaces, because the slot
 * resolves per theme — a raw hex from a definition would not.
 */
const NAMED_COLORS: Record<string, string> = {
  blue: 'var(--agent-1)',
  orange: 'var(--agent-2)',
  cyan: 'var(--agent-3)',
  yellow: 'var(--agent-4)',
  pink: 'var(--agent-5)',
  green: 'var(--agent-6)',
  purple: 'var(--agent-7)',
  red: 'var(--agent-8)',
};

export const definitionColor = (definition: AgentDefinition | undefined): string | undefined =>
  definition?.color ? NAMED_COLORS[definition.color.toLowerCase()] : undefined;
