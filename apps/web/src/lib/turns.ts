import type { MiranteEvent, PlanUsage, TokenUsage } from '@mirante/shared';
import { MAIN_AGENT_ID, addTokenUsage, emptyTokenUsage, requestText } from '@mirante/shared';

/**
 * One request: everything that happened because a person asked for something.
 *
 * Grouped by `promptId`, which every event carries. Events from before the turn
 * was identified — or from a Claude Code version that did not report one — fall
 * into a single unattributed bucket rather than being dropped.
 */
export type Turn = {
  promptId: string;
  prompt: string;
  startedAt: string;
  endedAt: string;
  agentsSpawned: number;
  agentTypes: string[];
  toolsRun: number;
  toolsFailed: number;
  tokens: TokenUsage;
  /** Plan usage as last reported during this turn, when the status line was reporting. */
  planUsage?: PlanUsage;
  /**
   * What this turn cost, when it can be known.
   *
   * Cost arrives as a running session total, and only from the status line. A
   * turn's share is the last total inside it minus the last total before it —
   * so with no reading before the turn there is no baseline, and the answer is
   * unknown rather than the whole session's cost filed under one request.
   */
  costUsd?: number;
  /** True while the turn has no Stop and no finished state yet. */
  open: boolean;
  eventCount: number;
};

const UNATTRIBUTED = '—';

export const buildTurns = (events: MiranteEvent[], sessionId: string): Turn[] => {
  // In time order: costs are running totals, so a delta taken in arrival order
  // would subtract the wrong reading.
  const bySession = events
    .filter((event) => event.sessionId === sessionId)
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id);
  const turns = new Map<string, Turn>();

  const ensure = (event: MiranteEvent): Turn => {
    const key = event.promptId ?? UNATTRIBUTED;
    const existing = turns.get(key);
    if (existing) {
      if (event.ts > existing.endedAt) existing.endedAt = event.ts;
      if (event.ts < existing.startedAt) existing.startedAt = event.ts;
      existing.eventCount += 1;
      return existing;
    }
    const created: Turn = {
      promptId: key,
      prompt: '',
      startedAt: event.ts,
      endedAt: event.ts,
      agentsSpawned: 0,
      agentTypes: [],
      toolsRun: 0,
      toolsFailed: 0,
      tokens: emptyTokenUsage(),
      open: true,
      eventCount: 1,
    };
    turns.set(key, created);
    return created;
  };

  // The running session total, and what it stood at when each turn began.
  let sessionCost: number | undefined;
  const costAtStart = new Map<string, number | undefined>();

  for (const event of bySession) {
    const key = event.promptId ?? UNATTRIBUTED;
    if (!turns.has(key)) costAtStart.set(key, sessionCost);
    const turn = ensure(event);
    switch (event.kind) {
      case 'prompt.submitted':
        // The daemon stops recording these, but its log is append-only: anything
        // captured before that rule existed is still here.
        // Only the main agent's prompt is the request. A subagent's first entry
        // is the brief its parent wrote, and it carries the parent's prompt id —
        // left unchecked, it overwrites what the person typed.
        if (event.agentId === MAIN_AGENT_ID) {
          const text = requestText(event.payload.preview);
          if (text) turn.prompt = text;
        }
        break;
      case 'agent.started':
        turn.agentsSpawned += 1;
        if (!turn.agentTypes.includes(event.payload.agentType)) {
          turn.agentTypes.push(event.payload.agentType);
        }
        break;
      case 'tool.started':
        turn.toolsRun += 1;
        break;
      case 'tool.failed':
        turn.toolsFailed += 1;
        break;
      case 'usage.updated':
        if (event.payload.scope === 'agent') {
          turn.tokens = addTokenUsage(turn.tokens, event.payload.tokens);
        } else if (event.payload.costUsd !== undefined) {
          sessionCost = event.payload.costUsd;
          const baseline = costAtStart.get(key);
          if (baseline !== undefined) turn.costUsd = Math.max(0, sessionCost - baseline);
        }
        break;
      case 'plan.usage.updated':
        turn.planUsage = event.payload.usage;
        break;
      case 'session.ended':
        turn.open = false;
        break;
      default:
        break;
    }
  }

  // A turn is closed once a newer one exists: the person asked for something else.
  const ordered = [...turns.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const [index, turn] of ordered.entries()) if (index > 0) turn.open = false;
  return ordered;
};

/** The most recent request across every session, for the strip at the top of the board. */
export const latestTurn = (
  events: MiranteEvent[],
): { turn: Turn; sessionId: string } | undefined => {
  // By time, not by position: the log is in arrival order, and the transcript
  // watcher re-reads older sessions, so a prompt from weeks ago can arrive after
  // one typed a minute ago. Only the main agent's prompts are requests — a
  // subagent's first entry is the brief its parent wrote, not something a
  // person asked.
  const last = events.reduce<MiranteEvent | undefined>((best, event) => {
    if (event.kind !== 'prompt.submitted' || event.agentId !== MAIN_AGENT_ID) return best;
    if (requestText(event.payload.preview) === undefined) return best;
    return best === undefined || event.ts > best.ts ? event : best;
  }, undefined);
  if (!last) return undefined;
  const turn = buildTurns(events, last.sessionId).find(
    (candidate) => candidate.promptId === (last.promptId ?? '—'),
  );
  return turn ? { turn, sessionId: last.sessionId } : undefined;
};

/**
 * Replies that only keep the work going, compared after lowercasing and
 * stripping accents and punctuation.
 *
 * A closed list rather than a length rule: "fix the build" is short and is a
 * request, and a length rule would hide it. Missing a follow-up costs nothing
 * worse than today's behaviour; hiding a request would.
 */
const FOLLOW_UPS = new Set([
  'continue',
  'continua',
  'go on',
  'go ahead',
  'proceed',
  'keep going',
  'yes',
  'y',
  'ok',
  'okay',
  'sure',
  'do it',
  'sim',
  's',
  'pode',
  'pode seguir',
  'pode continuar',
  'pode fazer',
  'pode comecar',
  'segue',
  'siga',
  'prossiga',
  'isso',
  'bora',
  'perfeito',
  'certo',
  'beleza',
  'faca isso',
]);

const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const isFollowUp = (text: string): boolean => {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 24) return false;
  // Punctuation alone — the "." typed to wake a terminal — asks for nothing.
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return true;
  return FOLLOW_UPS.has(normalize(trimmed));
};

export type LatestRequest = {
  sessionId: string;
  /** The last request with substance: what the person actually asked for. */
  turn: Turn;
  /** Short replies typed after it, oldest first. */
  followUps: Turn[];
  /** The request and its follow-ups, taken together. */
  startedAt: string;
  endedAt: string;
  tokens: TokenUsage;
  /** Only when every turn in the chain has a known cost; otherwise unknown. */
  costUsd?: number;
};

/**
 * What the person most recently asked for, looking through follow-ups.
 *
 * Headlining "Continue" answers nothing. The request it continues is the one
 * worth reading; the follow-ups are acknowledged and their cost counted.
 */
export const latestRequest = (events: MiranteEvent[]): LatestRequest | undefined => {
  const latest = latestTurn(events);
  if (!latest) return undefined;

  const turns = buildTurns(events, latest.sessionId)
    .filter((turn) => turn.prompt.length > 0)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  let index = turns.findIndex((turn) => turn.promptId === latest.turn.promptId);
  if (index < 0) return undefined;
  const followUps: Turn[] = [];
  while (index > 0 && isFollowUp(turns[index]?.prompt ?? '')) {
    followUps.unshift(turns[index] as Turn);
    index -= 1;
  }
  const head = turns[index] as Turn;
  const chain = [head, ...followUps];
  const costs = chain.map((turn) => turn.costUsd);

  return {
    sessionId: latest.sessionId,
    turn: head,
    followUps,
    startedAt: head.startedAt,
    endedAt: chain.reduce((max, turn) => (turn.endedAt > max ? turn.endedAt : max), head.endedAt),
    tokens: chain.map((turn) => turn.tokens).reduce(addTokenUsage, emptyTokenUsage()),
    ...(costs.every((cost): cost is number => cost !== undefined)
      ? { costUsd: costs.reduce((sum, cost) => sum + cost, 0) }
      : {}),
  };
};
