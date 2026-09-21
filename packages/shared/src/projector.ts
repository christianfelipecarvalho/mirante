import type {
  AgentCard,
  BoardState,
  PendingApproval,
  SessionLane,
  TimelineEntry,
  TimelineKind,
} from './board.js';
import { MAIN_AGENT_ID } from './agent.js';
import { dedupeKeyOf, sourceOutranks } from './dedupe.js';
import type { MiranteEvent } from './event.js';
import type { EventSource } from './kinds.js';
import { isTerminalState, type CardStatus, type WaitingOn } from './state.js';
import {
  PLAN_READING_MAX_AGE_MS,
  addTokenUsage,
  emptyTokenUsage,
  type PlanUsage,
} from './usage.js';

/** Timeline entries older than this are dropped; the board is a live view, not an archive. */
const TIMELINE_LIMIT = 2000;

/** At or above this percentage of a plan window, active cards are shown as rate limited. */
const RATE_LIMIT_THRESHOLD = 100;

const cardKey = (sessionId: string, agentId: string) => `${sessionId}::${agentId}`;

const projectNameOf = (projectPath: string): string =>
  projectPath.split('/').filter(Boolean).at(-1) ?? projectPath;

const waiting = (state: CardStatus['state'], on: WaitingOn): CardStatus =>
  ({ state, waitingOn: on }) as CardStatus;

const active = (state: 'idle' | 'thinking' | 'tool_running' | 'done' | 'error'): CardStatus => ({
  state,
});

/**
 * Folds the normalized event stream into the board.
 *
 * Lives in `shared`, not in the daemon, because both sides need it: the daemon
 * to answer with a snapshot, the browser to apply events as they stream in. Two
 * implementations of this would drift within a week.
 *
 * It performs no I/O and holds no timers — everything it knows came from an
 * event.
 */
export class BoardProjector {
  private readonly lanes = new Map<string, SessionLane>();
  private readonly cards = new Map<string, AgentCard>();
  private readonly pending = new Map<string, PendingApproval>();
  /** dedupeKey → the source that last wrote it, so a better source can overwrite. */
  private readonly applied = new Map<string, EventSource>();
  private timeline: TimelineEntry[] = [];
  /** dedupeKey → the row standing for that fact, so a correction rewrites it in place. */
  private readonly timelineByKey = new Map<string, TimelineEntry>();
  /**
   * Agents already counted against their parent's running children. A start is
   * reported by the hook and again by the transcript, and the better source is
   * applied over the first — counting both left a parent "3 running" with every
   * child finished.
   */
  private readonly countedStarts = new Set<string>();
  private planUsage: PlanUsage | undefined;
  private planUsageUpdatedAt: string | undefined;
  private lastEventId = 0;

  apply(event: MiranteEvent): void {
    if (event.id > this.lastEventId) this.lastEventId = event.id;

    // Two sources describing the same fact collapse here. The log keeps both;
    // the board shows one. See ADR-0002.
    const key = dedupeKeyOf(event);
    if (key) {
      const previous = this.applied.get(key);
      if (previous !== undefined && !sourceOutranks(event.source, previous)) return;
      this.applied.set(key, event.source);
    }

    // Plan limits belong to the account, not to a session. Folding them before a
    // lane exists is what lets the `/usage` probe report them without inventing
    // a session to hang them on.
    if (event.kind === 'plan.usage.updated') {
      // The newest reading wins, not the last one applied. Three sources report
      // it — the status line, the cached figure, the /usage command — each dated
      // when the figure was taken, and they do not arrive in that order.
      if (this.planUsageUpdatedAt === undefined || event.ts >= this.planUsageUpdatedAt) {
        // Only the status line reports the spend limit. A reading from the cache
        // or the command would otherwise erase it every minute, and the meter
        // would blink out until the next terminal refresh.
        const keptSpend =
          event.payload.usage.spendLimit === undefined ? this.planUsage?.spendLimit : undefined;
        this.planUsage = {
          ...event.payload.usage,
          ...(keptSpend ? { spendLimit: keptSpend } : {}),
        };
        this.planUsageUpdatedAt = event.ts;
      }
      return;
    }

    const lane = this.ensureLane(event);

    // An agent Mirante only ever saw finish started while the daemon was not
    // listening. There is no type, no task, no tokens and no duration to show —
    // a card for it would be an empty box with an opaque id for a name. Record
    // that it happened and move on.
    if (
      event.kind === 'agent.finished' &&
      !this.cards.has(cardKey(event.sessionId, event.agentId))
    ) {
      this.push(event, 'handoff.end', `${event.agentType ?? event.agentId} → ${MAIN_AGENT_ID}`);
      return;
    }

    const card = this.ensureCard(event);
    if (card.lastEventAt === undefined || event.ts > card.lastEventAt) card.lastEventAt = event.ts;

    switch (event.kind) {
      case 'session.started': {
        lane.entrypoint = event.payload.entrypoint;
        if (event.payload.cwd) {
          lane.projectPath = event.payload.cwd;
          lane.projectName = projectNameOf(event.payload.cwd);
        }
        if (event.payload.claudeVersion) lane.claudeVersion = event.payload.claudeVersion;
        if (event.payload.model) lane.model = event.payload.model;
        lane.startedAt = event.ts;
        break;
      }

      case 'session.ended': {
        lane.endedAt = event.ts;
        for (const c of lane.cards) {
          if (!isTerminalState(c.status.state)) {
            c.status = active('done');
            c.endedAt = event.ts;
            delete c.activity;
            delete c.currentTool;
          }
        }
        break;
      }

      case 'prompt.submitted': {
        card.status = active('thinking');
        card.activity = event.payload.preview;
        card.lastActivity = event.payload.preview;
        card.lastActivityKind = 'prompt';
        this.push(event, 'prompt', event.payload.preview);
        break;
      }

      case 'agent.started': {
        card.agentType = event.payload.agentType;
        // Kept out of `activity`, which the agent's first tool call overwrites.
        if (event.payload.description) card.task = event.payload.description;
        if (event.parentAgentId) card.parentAgentId = event.parentAgentId;
        if (event.payload.model) card.model = event.payload.model;
        card.spawnMode = event.payload.spawnMode;
        card.startedAt = event.ts;
        if (event.payload.description) {
          card.lastActivity = event.payload.description;
          delete card.lastActivityKind;
        }

        // A second report of the start can land after the finish — the watcher
        // reads a transcript later than the hook fired. It may correct the
        // details above, but it must not bring a finished agent back to life.
        const firstReport = !this.countedStarts.has(cardKey(event.sessionId, event.agentId));
        this.countedStarts.add(cardKey(event.sessionId, event.agentId));
        if (card.endedAt === undefined) {
          card.status = active('thinking');
          if (event.payload.description) card.activity = event.payload.description;
        }

        const parent = firstReport ? this.parentOf(event) : undefined;
        if (parent) {
          parent.runningChildren += 1;
          // Only a synchronous call blocks the parent. An async one leaves it
          // working, with a count badge instead of a waiting state.
          if (event.payload.spawnMode === 'sync') {
            parent.status = waiting('waiting_subagent', {
              summary: `Waiting on ${event.payload.agentType}`,
              reason: 'subagent',
              subject: event.payload.agentType,
              since: event.ts,
              ref: event.agentId,
              ...(event.payload.description ? { detail: event.payload.description } : {}),
            });
          }
        }
        this.push(
          event,
          'handoff.start',
          `${(parent ?? this.parentOf(event))?.agentType ?? (parent ?? this.parentOf(event))?.agentId ?? MAIN_AGENT_ID} → ${event.payload.agentType}`,
          event.payload.agentType,
        );
        break;
      }

      case 'agent.finished': {
        // The hook and the transcript both report an end, and the better source
        // is applied over the first. Only the first may count against the
        // parent's running children, or the count goes wrong by one per agent.
        const wasRunning = card.endedAt === undefined;
        card.status = active(event.payload.outcome === 'error' ? 'error' : 'done');
        card.endedAt = event.ts;
        delete card.activity;
        delete card.currentTool;

        const parent = this.parentOf(event);
        if (parent && wasRunning) {
          parent.runningChildren = Math.max(0, parent.runningChildren - 1);
          if (
            parent.status.state === 'waiting_subagent' &&
            parent.status.waitingOn?.ref === event.agentId
          ) {
            parent.status = active('thinking');
          }
        }
        const back = event.payload.handedBackTo ?? parent?.agentId ?? MAIN_AGENT_ID;
        this.push(
          event,
          'handoff.end',
          `${card.agentType ?? event.agentId} → ${back}`,
          card.agentType,
        );
        break;
      }

      case 'tool.started': {
        card.status = active('tool_running');
        card.currentTool = {
          toolUseId: event.payload.toolUseId,
          toolName: event.payload.toolName,
          summary: event.payload.summary,
          startedAt: event.ts,
        };
        card.activity = event.payload.summary
          ? `${event.payload.toolName}: ${event.payload.summary}`
          : event.payload.toolName;
        card.lastActivity = card.activity;
        delete card.lastActivityKind;
        this.push(event, 'tool', card.activity, event.payload.toolName);
        break;
      }

      case 'tool.finished': {
        if (card.currentTool?.toolUseId === event.payload.toolUseId) {
          delete card.currentTool;
          delete card.activity;
          if (card.status.state === 'tool_running') card.status = active('thinking');
        }
        break;
      }

      case 'tool.failed': {
        if (card.currentTool?.toolUseId === event.payload.toolUseId) {
          delete card.currentTool;
          if (card.status.state === 'tool_running') card.status = active('thinking');
        }
        card.activity = `${event.payload.toolName} failed`;
        card.lastActivity = card.activity;
        delete card.lastActivityKind;
        this.push(
          event,
          'tool.failed',
          `${event.payload.toolName}: ${event.payload.errorPreview}`,
          event.payload.toolName,
        );
        break;
      }

      case 'skill.invoked': {
        card.activeSkill = event.payload.skillName;
        this.push(event, 'skill', event.payload.skillName, event.payload.skillName);
        break;
      }

      case 'permission.requested': {
        this.pending.set(event.payload.requestId, {
          requestId: event.payload.requestId,
          sessionId: event.sessionId,
          agentId: event.agentId,
          toolName: event.payload.toolName,
          inputPreview: event.payload.inputPreview,
          requestedAt: event.ts,
          decideBy: event.payload.decideBy,
        });
        card.status = waiting('waiting_approval', {
          summary: `Approve ${event.payload.toolName}: ${event.payload.inputPreview}`,
          reason: 'approval',
          subject: event.payload.toolName,
          detail: event.payload.inputPreview,
          since: event.ts,
          ref: event.payload.requestId,
        });
        this.push(
          event,
          'permission',
          `${event.payload.toolName} needs approval`,
          event.payload.toolName,
        );
        break;
      }

      case 'permission.resolved': {
        this.pending.delete(event.payload.requestId);
        if (
          card.status.state === 'waiting_approval' &&
          card.status.waitingOn?.ref === event.payload.requestId
        ) {
          card.status = active('thinking');
        }
        const how = event.payload.via === 'fallback' ? 'asked in terminal' : event.payload.decision;
        this.push(
          event,
          'permission',
          `Permission ${how}`,
          event.payload.via === 'fallback' ? 'fallback' : event.payload.decision,
        );
        break;
      }

      case 'usage.updated': {
        if (event.payload.scope === 'agent') {
          card.tokens = addTokenUsage(card.tokens, event.payload.tokens);
          lane.tokens = addTokenUsage(lane.tokens, event.payload.tokens);
          if (event.payload.model) card.model = event.payload.model;
        }
        // Cost and context come from the status line, which reports per session.
        if (event.payload.costUsd !== undefined) lane.costUsd = event.payload.costUsd;
        if (event.payload.context) lane.context = event.payload.context;
        if (event.payload.model && event.agentId === MAIN_AGENT_ID)
          lane.model = event.payload.model;
        break;
      }

      case 'context.compacted': {
        if (event.payload.phase === 'pre')
          this.push(event, 'compaction', 'Context compacted', 'context');
        break;
      }

      case 'waiting.changed': {
        card.status = event.payload.status;
        if (!event.payload.status.waitingOn) delete card.activity;
        else card.activity = event.payload.status.waitingOn.summary;
        break;
      }

      case 'error.raised': {
        card.status = active('error');
        card.activity = event.payload.message;
        if (event.payload.kind === 'rate_limit') {
          // The hook and the transcript both report the refusal, in either
          // order, and only the transcript knows the window. A later report
          // without it must not erase the one that had it.
          card.stoppedAtLimit = event.payload.limit ?? card.stoppedAtLimit ?? {};
        } else {
          delete card.stoppedAtLimit;
        }
        this.push(event, 'error', event.payload.message);
        break;
      }
    }
  }

  applyAll(events: Iterable<MiranteEvent>): void {
    for (const event of events) this.apply(event);
  }

  /**
   * `now` exists for the plan-limit overlay: a reading that said 100% stops
   * meaning anything once its window resets, and only a clock can tell.
   */
  snapshot(now: number = Date.now()): BoardState {
    const limited = this.atPlanLimit(now);
    const sessions = [...this.lanes.values()]
      .map((lane) => ({
        ...lane,
        cards: lane.cards
          .map((card) => (limited ? this.withRateLimitOverlay(card, limited) : { ...card }))
          .sort((a, b) => {
            if (a.agentId === MAIN_AGENT_ID) return -1;
            if (b.agentId === MAIN_AGENT_ID) return 1;
            return a.startedAt.localeCompare(b.startedAt);
          }),
      }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    return {
      lastEventId: this.lastEventId,
      sessions,
      ...(this.planUsage ? { planUsage: this.planUsage } : {}),
      ...(this.planUsageUpdatedAt ? { planUsageUpdatedAt: this.planUsageUpdatedAt } : {}),
      timeline: [...this.timeline],
      pendingApprovals: [...this.pending.values()],
    };
  }

  /**
   * Being at the plan ceiling is a property of the account, not of a card, so it
   * is applied as a display overlay rather than written into card state. That
   * way it disappears by itself when the window resets, with nothing to undo.
   */
  private atPlanLimit(now: number): WaitingOn | undefined {
    const readingAge = this.planUsageUpdatedAt
      ? now - Date.parse(this.planUsageUpdatedAt)
      : Number.POSITIVE_INFINITY;
    // `subject` is a stable key the interface localises; `summary` stays English
    // as the required fallback.
    const windows = [
      ['fiveHour', '5-hour limit', this.planUsage?.fiveHour],
      ['sevenDay', 'weekly limit', this.planUsage?.sevenDay],
      ['spendLimit', 'spend limit', this.planUsage?.spendLimit],
    ] as const;
    for (const [key, label, window] of windows) {
      // A reading of 100% whose window has since reset says nothing about now.
      // Without this, one stale reading from last night marks every card on the
      // board as rate limited this morning — observed.
      if (window?.resetsAt !== undefined && window.resetsAt * 1000 <= now) continue;
      // With no reset time to check against, only a recent reading may assert
      // the limit; otherwise a single 100% would mark cards limited forever.
      if (window?.resetsAt === undefined && readingAge > PLAN_READING_MAX_AGE_MS) continue;
      if (window && window.usedPercentage >= RATE_LIMIT_THRESHOLD) {
        return {
          summary: window.resetsAt
            ? `At ${label} — resets ${new Date(window.resetsAt * 1000).toISOString()}`
            : `At ${label}`,
          reason: 'plan_limit',
          subject: key,
          since: this.planUsageUpdatedAt ?? new Date(now).toISOString(),
          ref: key,
        };
      }
    }
    return undefined;
  }

  private withRateLimitOverlay(card: AgentCard, on: WaitingOn): AgentCard {
    if (isTerminalState(card.status.state)) return { ...card };
    return { ...card, status: waiting('rate_limited', on) };
  }

  private parentOf(event: MiranteEvent): AgentCard | undefined {
    if (!event.parentAgentId) return undefined;
    return this.cards.get(cardKey(event.sessionId, event.parentAgentId));
  }

  private ensureLane(event: MiranteEvent): SessionLane {
    const existing = this.lanes.get(event.sessionId);
    if (existing) {
      if (event.gitBranch) existing.gitBranch = event.gitBranch;
      // The first event of a session can arrive before anything knows where it
      // is running — a hook fires before the transcript is flushed. Fill the
      // lane's identity in from whichever event supplies it first.
      if (!existing.projectPath && event.projectPath) {
        existing.projectPath = event.projectPath;
        existing.projectName = projectNameOf(event.projectPath);
      }
      return existing;
    }
    const lane: SessionLane = {
      sessionId: event.sessionId,
      projectPath: event.projectPath,
      projectName: projectNameOf(event.projectPath),
      ...(event.gitBranch ? { gitBranch: event.gitBranch } : {}),
      entrypoint: 'unknown',
      startedAt: event.ts,
      tokens: emptyTokenUsage(),
      cards: [],
    };
    this.lanes.set(event.sessionId, lane);
    return lane;
  }

  private ensureCard(event: MiranteEvent): AgentCard {
    const key = cardKey(event.sessionId, event.agentId);
    const existing = this.cards.get(key);
    if (existing) return existing;

    const card: AgentCard = {
      agentId: event.agentId,
      sessionId: event.sessionId,
      ...(event.agentType ? { agentType: event.agentType } : {}),
      ...(event.parentAgentId ? { parentAgentId: event.parentAgentId } : {}),
      status: active('idle'),
      tokens: emptyTokenUsage(),
      startedAt: event.ts,
      runningChildren: 0,
    };
    this.cards.set(key, card);
    this.lanes.get(event.sessionId)?.cards.push(card);
    return card;
  }

  private push(event: MiranteEvent, kind: TimelineKind, text: string, subject?: string): void {
    const card = this.cards.get(cardKey(event.sessionId, event.agentId));

    // A better-sourced report of the same fact corrects the existing row. Without
    // this, a tool call seen first by a hook and then by the transcript would be
    // listed twice, which is the timeline lying about how much happened.
    const key = dedupeKeyOf(event);
    const existing = key ? this.timelineByKey.get(key) : undefined;
    if (existing) {
      existing.text = text;
      if (subject !== undefined) existing.subject = subject;
      existing.ts = event.ts;
      if (card?.agentType) existing.agentType = card.agentType;
      return;
    }

    const entry: TimelineEntry = {
      id: event.id,
      ts: event.ts,
      sessionId: event.sessionId,
      agentId: event.agentId,
      ...(card?.agentType ? { agentType: card.agentType } : {}),
      kind,
      text,
      ...(subject === undefined ? {} : { subject }),
      ...(key ? { dedupeKey: key } : {}),
    };
    this.timeline.push(entry);
    if (key) this.timelineByKey.set(key, entry);

    if (this.timeline.length > TIMELINE_LIMIT) {
      const dropped = this.timeline.slice(0, this.timeline.length - TIMELINE_LIMIT);
      for (const old of dropped) if (old.dedupeKey) this.timelineByKey.delete(old.dedupeKey);
      this.timeline = this.timeline.slice(-TIMELINE_LIMIT);
    }
  }
}

export const projectBoard = (events: Iterable<MiranteEvent>): BoardState => {
  const projector = new BoardProjector();
  projector.applyAll(events);
  return projector.snapshot();
};
