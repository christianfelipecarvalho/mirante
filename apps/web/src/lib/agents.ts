import type { AgentCard } from '@mirante/shared';
import type { IconName } from './icon-set.js';
import type { Translate } from './i18n.js';

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
  // No type at all means the agent was already running before Mirante saw it —
  // typically only its SubagentStop arrived. Claiming it came from
  // `.claude/agents` would be inventing a fact.
  if (!card.agentType) return 'role.unknown';
  return ROLE_KEYS[card.agentType] ?? 'role.custom';
};

/**
 * A position among agents that share a type.
 *
 * Three cards all reading "general-purpose" are impossible to tell apart or
 * refer to. Returns undefined when the type appears once, so a lone agent does
 * not carry a pointless "#1".
 */
export const agentOrdinals = (
  cards: readonly AgentCard[],
  nameOf: (card: AgentCard) => string,
): Map<string, number> => {
  const root = cards.find((card) => card.agentId === 'main');
  const rootName = root ? nameOf(root) : undefined;
  const others = cards.filter((card) => card.agentId !== 'main');

  const counts = new Map<string, number>();
  for (const card of others) {
    const name = nameOf(card);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  const ordinals = new Map<string, number>();
  for (const card of others) {
    const name = nameOf(card);
    const sharesRoot = name === rootName;
    // A name only the root and this card use still needs numbering: the point of
    // "Principal 2" is that it says a second unidentified agent exists.
    if (!sharesRoot && (counts.get(name) ?? 0) < 2) continue;

    // The root keeps its name unnumbered, so its namesakes start at 2.
    const start = sharesRoot ? 2 : 1;
    const next = (seen.get(name) ?? start - 1) + 1;
    seen.set(name, next);
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

/**
 * The name worth putting first.
 *
 * An agent's type is frequently generic — three can all be "general-purpose"
 * while one is the architect, one the PM and one the designer. When the task
 * opens with a role ("Arquiteto: tutoriais interativos"), that role is what
 * identifies the agent, and the type becomes the small print.
 *
 * Deliberately conservative: only a short prefix before a colon counts, so a
 * task that happens to contain punctuation does not turn into a nonsense name.
 */
const MAX_ROLE_LENGTH = 26;

export const agentRoleName = (task: string | undefined): string | undefined => {
  if (!task) return undefined;
  const [head, ...rest] = task.split(':');
  if (rest.length === 0) return undefined;
  const role = (head ?? '').trim();
  if (role.length === 0 || role.length > MAX_ROLE_LENGTH) return undefined;
  // A colon with nothing after it is punctuation, not a label.
  if (rest.join(':').trim().length === 0) return undefined;
  return role;
};

/** What the task said, minus the role already shown as the title. */
export const agentTaskDetail = (task: string | undefined): string | undefined => {
  if (!task) return undefined;
  if (!agentRoleName(task)) return task;
  const detail = task.slice(task.indexOf(':') + 1).trim();
  return detail.length > 0 ? detail : undefined;
};

/**
 * A role read from what the agent was told to do.
 *
 * Most tasks never name a role — they name an action. "Revisar o export de
 * leads" is analysis; "implementar o botão" is development. Reading the verb
 * gives a card something to be called besides the type it shares with every
 * other agent in the session.
 *
 * Both languages this interface speaks, because the task is written by whoever
 * typed the prompt.
 */
export type InferredRole =
  'analyst' | 'dev' | 'qa' | 'docs' | 'designer' | 'architect' | 'explorer';

/**
 * Checked in order, first match wins.
 *
 * Specific actions come before domain words, because the verb is what the agent
 * was told to *do*: "analisar o layout" is analysis, not design, and "escrever
 * testes" is QA, not development. Reading the noun first gets both wrong.
 */
const ROLE_VERBS: [InferredRole, readonly string[]][] = [
  [
    'qa',
    ['testar', 'teste', 'testes', 'test ', 'tests', 'qa ', 'validar', 'validate', 'cobertura'],
  ],
  ['docs', ['document', 'docs', 'readme']],
  ['architect', ['arquitet', 'architect']],
  [
    'analyst',
    [
      'analis',
      'analise',
      'analy',
      'revis',
      'review',
      'investig',
      'audit',
      'verific',
      'checar',
      'check ',
      'examin',
      'avaliar',
      'diagnostic',
      'entender',
      'understand',
    ],
  ],
  ['designer', ['design', 'layout', 'interface', 'ux', 'ui ', 'prototipo', 'mockup']],
  [
    'dev',
    [
      'implement',
      'criar',
      'crie',
      'create',
      'escrever',
      'write ',
      'corrig',
      'fix ',
      'ajust',
      'refator',
      'refactor',
      'adicionar',
      'add ',
      'build',
      'construir',
      'migrar',
    ],
  ],
  [
    'explorer',
    ['explor', 'buscar', 'procurar', 'encontrar', 'find ', 'search', 'localizar', 'mapear'],
  ],
];

export const inferAgentRole = (task: string | undefined): InferredRole | undefined => {
  if (!task) return undefined;
  const text = task
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  for (const [role, needles] of ROLE_VERBS) {
    if (
      needles.some((needle) =>
        text.includes(needle.normalize('NFD').replace(/[\u0300-\u036f]/g, '')),
      )
    ) {
      return role;
    }
  }
  return undefined;
};

export const ROLE_ICON: Record<InferredRole, IconName> = {
  analyst: 'magnify',
  dev: 'pencil',
  qa: 'beaker',
  docs: 'file',
  designer: 'palette',
  architect: 'compass',
  explorer: 'search',
};

/**
 * Everything the interface needs to introduce an agent: what to call it, and
 * what to draw for it.
 *
 * One place decides this, because a card, a filter chip and a log row that
 * disagree about an agent's name are three different agents as far as the
 * reader is concerned.
 */
export type AgentIdentity = {
  /** The name that leads: a stated role, an inferred one, or the type. */
  name: string;
  /** The type, shown as small print when the name came from somewhere else. */
  typeLabel?: string;
  /** What the task said, minus any role already used as the name. */
  detail?: string;
  role?: InferredRole;
};

export const describeAgent = (
  card: Pick<AgentCard, 'agentId' | 'agentType' | 'task'>,
  t: Translate,
): AgentIdentity => {
  if (card.agentId === 'main') return { name: t('card.session') };

  const stated = agentRoleName(card.task);
  const detail = agentTaskDetail(card.task);
  if (stated) {
    return {
      name: stated,
      ...(card.agentType ? { typeLabel: card.agentType } : {}),
      ...(detail ? { detail } : {}),
    };
  }

  // No role in the task, so read the verb: "revisar o export" is analysis,
  // "implementar o botão" is development.
  const inferred = inferAgentRole(card.task);
  if (inferred) {
    return {
      name: t(`agentRole.${inferred}` as 'agentRole.analyst'),
      ...(card.agentType ? { typeLabel: card.agentType } : {}),
      ...(detail ? { detail } : {}),
      role: inferred,
    };
  }

  // Nothing identifies this one: not a stated role, not a verb, and its type is
  // the generic one every agent shares. Give it the root's name so the count
  // makes the situation legible — "Principal 2" says there is more than one
  // unspecified agent, which a bare type never would.
  const anonymous = !card.agentType || GENERIC_TYPE_NAMES.has(card.agentType.toLowerCase());
  return {
    name: anonymous ? t('card.session') : card.agentType!,
    ...(anonymous && card.agentType ? { typeLabel: card.agentType } : {}),
    ...(detail ? { detail } : {}),
  };
};

/** Types that say nothing about the agent, so they cannot serve as its name. */
const GENERIC_TYPE_NAMES = new Set(['general-purpose', 'general', 'claude', 'agent', 'task']);
