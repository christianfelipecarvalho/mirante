import type { MiranteEvent } from '@mirante/shared';

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

export type StepStatus = 'running' | 'ok' | 'failed' | 'info';

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

export const buildSteps = (events: MiranteEvent[], filter: StepFilter): Step[] => {
  const relevant = events.filter(
    (event) =>
      event.sessionId === filter.sessionId &&
      (filter.agentId === undefined || event.agentId === filter.agentId) &&
      (filter.promptId === undefined || event.promptId === filter.promptId),
  );

  const steps: Step[] = [];
  /** Open tool calls, so a finish can close the line it belongs to. */
  const openTools = new Map<string, Step>();

  const base = (event: MiranteEvent) => ({
    id: event.id,
    ts: event.ts,
    agentId: event.agentId,
    ...(event.agentType === undefined ? {} : { agentType: event.agentType }),
  });

  for (const event of relevant) {
    switch (event.kind) {
      case 'prompt.submitted':
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
          title: event.payload.agentType,
          ...(event.payload.description ? { detail: event.payload.description } : {}),
          status: 'running',
        });
        break;

      case 'agent.finished':
        steps.push({
          ...base(event),
          kind: 'agent',
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
          status: 'failed',
        });
        break;

      default:
        // usage.updated, session.*, waiting.changed carry no step of their own.
        break;
    }
  }

  return steps;
};
