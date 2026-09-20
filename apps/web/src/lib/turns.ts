import type { MiranteEvent, PlanUsage, TokenUsage } from '@mirante/shared';
import { addTokenUsage, emptyTokenUsage, isInjectedMessage } from '@mirante/shared';

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
  /** True while the turn has no Stop and no finished state yet. */
  open: boolean;
  eventCount: number;
};

const UNATTRIBUTED = '—';

export const buildTurns = (events: MiranteEvent[], sessionId: string): Turn[] => {
  const bySession = events.filter((event) => event.sessionId === sessionId);
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

  for (const event of bySession) {
    const turn = ensure(event);
    switch (event.kind) {
      case 'prompt.submitted':
        // The daemon stops recording these, but its log is append-only: anything
        // captured before that rule existed is still here.
        if (!isInjectedMessage(event.payload.preview)) turn.prompt = event.payload.preview;
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
  const prompts = events.filter(
    (event) => event.kind === 'prompt.submitted' && !isInjectedMessage(event.payload.preview),
  );
  const last = prompts.at(-1);
  if (!last) return undefined;
  const turn = buildTurns(events, last.sessionId).find(
    (candidate) => candidate.promptId === (last.promptId ?? '—'),
  );
  return turn ? { turn, sessionId: last.sessionId } : undefined;
};
