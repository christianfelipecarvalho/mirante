import {
  MAIN_AGENT_ID,
  dedupeKeyOf,
  isInjectedMessage,
  requestText,
  sourceOutranks,
  type MiranteEvent,
} from '@mirante/shared';

/**
 * One readable line of what an agent did.
 *
 * The raw stream is not that: a tool call arrives as a start and a finish, often
 * from two different sources, with usage updates interleaved. A person reading
 * "what is this agent doing" wants the call as one line with an outcome and a
 * duration, which is what this builds.
 */
export type StepKind =
  'prompt' | 'tool' | 'agent' | 'skill' | 'permission' | 'compaction' | 'error';

/**
 * `limited` is a stop the plan imposed, not a failure: painted in the serious
 * tone with a pause, never in the critical red that means something broke.
 */
export type StepStatus = 'running' | 'ok' | 'failed' | 'info' | 'limited';

export type Step = {
  id: number;
  ts: string;
  kind: StepKind;
  /** The short name: a tool, an agent type, a skill. */
  title: string;
  /** The argument or message, already truncated and redacted at ingest. */
  detail?: string;
  status: StepStatus;
  durationMs?: number;
  agentId: string;
  agentType?: string;
  /**
   * What happened, for rows whose title would otherwise repeat the agent column.
   * Rendered in the reader's language rather than baked into the title.
   */
  verb?: 'spawned' | 'returned';
  /** The request that caused this step, so the activity can be read turn by turn. */
  promptId?: string;
  /** For an error: its category, which the interface names in the reader's language. */
  errorKind?: 'api' | 'tool' | 'parse' | 'internal' | 'rate_limit';
  /** For a plan-limit refusal: which window, and when it reopens. */
  limit?: { window?: string; resetsAt?: number };
  /**
   * A prompt Claude Code wrote to itself — a subagent reporting back, a task
   * notification. Never a row; it only says what opened the turn.
   */
  injected?: boolean;
};

const durationBetween = (from: string, to: string): number | undefined => {
  const start = Date.parse(from);
  const end = Date.parse(to);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
};

export type StepFilter = {
  sessionId: string;
  /** Undefined means every agent in the session. */
  agentId?: string | undefined;
  promptId?: string | undefined;
};

/**
 * Collapses the two reports of one fact into the better one.
 *
 * A tool call is recorded twice on purpose — a hook sees it first, the
 * transcript describes it properly — and the log keeps both because it is an
 * audit trail. The board's projector already folds them; anything reading raw
 * events has to do the same or every action is listed twice.
 */
const dedupe = (events: MiranteEvent[]): MiranteEvent[] => {
  const winners = new Map<string, MiranteEvent>();
  const passthrough: MiranteEvent[] = [];

  for (const event of events) {
    const key = dedupeKeyOf(event);
    if (!key) {
      passthrough.push(event);
      continue;
    }
    const existing = winners.get(key);
    if (!existing || sourceOutranks(event.source, existing.source)) {
      winners.set(key, event);
    }
  }

  return [...passthrough, ...winners.values()].sort(
    (a, b) => a.ts.localeCompare(b.ts) || a.id - b.id,
  );
};

export const buildSteps = (events: MiranteEvent[], filter: StepFilter): Step[] => {
  const relevant = dedupe(
    events.filter(
      (event) =>
        event.sessionId === filter.sessionId &&
        (filter.agentId === undefined || event.agentId === filter.agentId) &&
        (filter.promptId === undefined || event.promptId === filter.promptId),
    ),
  );

  const steps: Step[] = [];
  /** Open tool calls, so a finish can close the line it belongs to. */
  const openTools = new Map<string, Step>();

  const base = (event: MiranteEvent) => ({
    id: event.id,
    ts: event.ts,
    agentId: event.agentId,
    ...(event.agentType === undefined ? {} : { agentType: event.agentType }),
    ...(event.promptId === undefined ? {} : { promptId: event.promptId }),
  });

  for (const event of relevant) {
    switch (event.kind) {
      case 'prompt.submitted':
        if (isInjectedMessage(event.payload.preview)) {
          steps.push({
            ...base(event),
            kind: 'prompt',
            title: 'prompt',
            detail: event.payload.preview,
            status: 'info',
            injected: true,
          });
          break;
        }
        steps.push({
          ...base(event),
          kind: 'prompt',
          title: 'prompt',
          detail: event.payload.preview,
          status: 'info',
        });
        break;

      case 'tool.started': {
        const step: Step = {
          ...base(event),
          kind: 'tool',
          title: event.payload.toolName,
          ...(event.payload.summary ? { detail: event.payload.summary } : {}),
          status: 'running',
        };
        openTools.set(event.payload.toolUseId, step);
        steps.push(step);
        break;
      }

      case 'tool.finished': {
        const open = openTools.get(event.payload.toolUseId);
        if (open) {
          open.status = 'ok';
          const elapsed = durationBetween(open.ts, event.ts);
          if (elapsed !== undefined) open.durationMs = elapsed;
          openTools.delete(event.payload.toolUseId);
        }
        break;
      }

      case 'tool.failed': {
        const open = openTools.get(event.payload.toolUseId);
        if (open) {
          open.status = 'failed';
          open.detail = event.payload.errorPreview || open.detail;
          const elapsed = durationBetween(open.ts, event.ts);
          if (elapsed !== undefined) open.durationMs = elapsed;
          openTools.delete(event.payload.toolUseId);
        } else {
          steps.push({
            ...base(event),
            kind: 'tool',
            title: event.payload.toolName,
            detail: event.payload.errorPreview,
            status: 'failed',
          });
        }
        break;
      }

      case 'agent.started':
        steps.push({
          ...base(event),
          kind: 'agent',
          verb: 'spawned',
          title: event.payload.agentType,
          ...(event.payload.description ? { detail: event.payload.description } : {}),
          status: 'running',
        });
        break;

      case 'agent.finished':
        steps.push({
          ...base(event),
          kind: 'agent',
          verb: 'returned',
          title: event.agentType ?? event.agentId,
          status: event.payload.outcome === 'error' ? 'failed' : 'ok',
        });
        break;

      case 'skill.invoked':
        steps.push({
          ...base(event),
          kind: 'skill',
          title: event.payload.skillName,
          status: 'info',
        });
        break;

      case 'permission.requested':
        steps.push({
          ...base(event),
          kind: 'permission',
          title: event.payload.toolName,
          detail: event.payload.inputPreview,
          status: 'running',
        });
        break;

      case 'permission.resolved':
        steps.push({
          ...base(event),
          kind: 'permission',
          title: event.payload.decision,
          ...(event.payload.via === 'fallback' ? { detail: 'terminal' } : {}),
          status: event.payload.decision === 'deny' ? 'failed' : 'ok',
        });
        break;

      case 'context.compacted':
        if (event.payload.phase === 'pre') {
          steps.push({ ...base(event), kind: 'compaction', title: 'compact', status: 'info' });
        }
        break;

      case 'error.raised':
        steps.push({
          ...base(event),
          kind: 'error',
          title: event.payload.kind,
          detail: event.payload.message,
          // Mirante failing to read a line is not the agent failing.
          status:
            event.payload.kind === 'rate_limit'
              ? 'limited'
              : event.payload.kind === 'parse'
                ? 'info'
                : 'failed',
          errorKind: event.payload.kind,
          ...(event.payload.limit ? { limit: event.payload.limit } : {}),
        });
        break;

      default:
        // usage.updated, session.*, waiting.changed carry no step of their own.
        break;
    }
  }

  return steps;
};

/** Steps that share the request that caused them. */
export type TurnGroup = {
  /** The turn's prompt id, or `—` for steps no request could be tied to. */
  promptId: string;
  /** What the person typed, when it was captured. */
  prompt?: string;
  /**
   * When no person typed it: what opened the turn. A turn started by a subagent
   * reporting back is not "text not captured" — nothing was lost.
   */
  origin?: 'agent' | 'system';
  startedAt: string;
  endedAt: string;
  /** Newest first. The main agent's own prompt row is the header, not a row. */
  steps: Step[];
  failed: number;
};

/**
 * Groups the activity under the request that caused it, newest request first.
 *
 * Read flat, a session is hundreds of tool calls with no way to tell which
 * request they answered. Grouped, each request is a header you can open.
 */
export const groupStepsByTurn = (steps: Step[]): TurnGroup[] => {
  const groups = new Map<string, TurnGroup>();
  for (const step of steps) {
    const key = step.promptId ?? '—';
    let group = groups.get(key);
    if (!group) {
      group = { promptId: key, startedAt: step.ts, endedAt: step.ts, steps: [], failed: 0 };
      groups.set(key, group);
    }
    if (step.ts < group.startedAt) group.startedAt = step.ts;
    if (step.ts > group.endedAt) group.endedAt = step.ts;

    if (step.injected) {
      if (step.agentId === MAIN_AGENT_ID && !group.origin) {
        const head = (step.detail ?? '').trimStart();
        group.origin =
          head.startsWith('<agent-message') ||
          head.startsWith('<task-notification>') ||
          head.startsWith('[Subagent hand-back]')
            ? 'agent'
            : 'system';
      }
      continue;
    }
    if (step.kind === 'prompt' && step.agentId === MAIN_AGENT_ID) {
      const text = requestText(step.detail ?? '');
      if (text) group.prompt = text;
      continue;
    }
    group.steps.push(step);
    if (step.status === 'failed') group.failed += 1;
  }

  const newestFirst = (a: { ts: string; id: number }, b: { ts: string; id: number }) =>
    b.ts.localeCompare(a.ts) || b.id - a.id;
  return [...groups.values()]
    .map((group) => ({ ...group, steps: [...group.steps].sort(newestFirst) }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
};
