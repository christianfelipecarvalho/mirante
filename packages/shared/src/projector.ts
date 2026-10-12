import type {
  AgentCard,
  BoardState,
  HarnessPlan,
  PendingApproval,
  SessionLane,
  TimelineEntry,
  TimelineKind,
} from './board.js';
import { TokenLedger } from './token-ledger.js';
import { MAIN_AGENT_ID } from './agent.js';
import { REREADABLE_KINDS, dedupeKeyOf, dedupeKeys, sourceOutranks } from './dedupe.js';
import type { MiranteEvent, MiranteEventOf } from './event.js';
import type { EventSource, Harness } from './kinds.js';
import { isTerminalState, type CardStatus, type WaitingOn } from './state.js';
import { livenessOf } from './liveness.js';
import type { AgentControlRun } from './control.js';
import { isTaskContinuation } from './work-plan.js';
import { requestText } from './text.js';
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
  private readonly tokenLedger = new TokenLedger();
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
  /** Late re-reads enrich the matching assignment, never replace a newer one. */
  private readonly assignmentAt = new Map<string, { startKey: string; ts: string }>();
  /**
   * cardKey → when its current request was typed. A skill reported late — a
   * transcript read after the next prompt, a log written before a parser knew
   * how to see it — belongs to an earlier request and must not be shown as in
   * use now. Arrival order cannot say that; the origin time can.
   */
  private readonly promptedAt = new Map<string, string>();
  /** Current assignment boundary, independent of acknowledgements and lifecycle state. */
  private readonly workScopeAt = new Map<
    string,
    { ts: string; promptId?: string; assignmentId?: string }
  >();
  private readonly promptDates = new Map<string, Map<string, string>>();
  private readonly planKeys = new Map<string, string>();
  private readonly finishKeys = new Map<string, string>();
  /** Child files can be flushed before the parent's assignment result. */
  private readonly deferredPlans = new Map<
    string,
    Map<string, MiranteEventOf<'task.plan.updated'>>
  >();
  /**
   * cardKey → when the card's model was last seen in one of its own replies.
   *
   * A spawn declares a model — often an alias, "opus" — and the replies name
   * the exact one. The reply wins, and the newest reply wins among replies, so
   * a re-read start or a late report cannot put back a model the agent has
   * since stopped using.
   */
  private readonly modelSeenAt = new Map<string, string>();
  private readonly effortSeenAt = new Map<string, string>();
  /** New execution, rather than arrival order, separates a resume from an old close. */
  private readonly sessionWorkAt = new Map<string, string>();
  private planUsage: PlanUsage | undefined;
  private planUsageUpdatedAt: string | undefined;
  /** Every other harness's plan, newest reading each. */
  private readonly harnessPlans = new Map<Exclude<Harness, 'claude-code'>, HarnessPlan>();
  private lastEventId = 0;
  private readonly controlRuns = new Map<string, AgentControlRun>();

  apply(event: MiranteEvent): void {
    if (event.id > this.lastEventId) this.lastEventId = event.id;

    // Two sources describing the same fact collapse here. The log keeps both;
    // the board shows one. See ADR-0002.
    const key = dedupeKeyOf(event);
    if (key) {
      const previous = this.applied.get(key);
      if (
        previous !== undefined &&
        !sourceOutranks(event.source, previous) &&
        (!REREADABLE_KINDS.has(event.kind) || sourceOutranks(previous, event.source))
      ) {
        return;
      }
      this.applied.set(key, event.source);
    }

    // Control acknowledgement is not evidence of task activity or completion.
    // Keep it replayable without making an old agent look alive or inventing one.
    if (event.kind === 'agent.control.updated') {
      this.controlRuns.set(event.payload.runId, {
        ...event.payload,
        sessionId: event.sessionId,
        agentId: event.agentId,
      });
      if (this.controlRuns.size > 200)
        this.controlRuns.delete(this.controlRuns.keys().next().value!);
      return;
    }

    // Receiving an instruction is not evidence that execution started, nor that
    // the recipient changed parents. Activity readers consume the logged event.
    if (event.kind === 'agent.instruction') return;

    // Plan limits belong to the account, not to a session. Folding them before a
    // lane exists is what lets the `/usage` probe report them without inventing
    // a session to hang them on.
    if (event.kind === 'plan.usage.updated') {
      const harness = event.payload.harness;
      if (harness !== undefined && harness !== 'claude-code') {
        // Another account, read from its own files: kept apart, newest first.
        const known = this.harnessPlans.get(harness);
        if (known === undefined || event.ts >= known.updatedAt) {
          this.harnessPlans.set(harness, {
            usage: event.payload.usage,
            updatedAt: event.ts,
            ...(event.payload.planType ? { planType: event.payload.planType } : {}),
          });
        }
        return;
      }
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
    if (event.kind === 'agent.finished') {
      const finishKey = cardKey(event.sessionId, event.agentId);
      const scope = this.workScopeAt.get(finishKey);
      const sameAssignment =
        scope?.assignmentId && scope.assignmentId === event.payload.assignmentId;
      if (scope?.assignmentId && event.payload.assignmentId && !sameAssignment) return;
      if (scope && event.ts < scope.ts && !sameAssignment) return;
      if (
        card.endedAt &&
        event.ts < card.endedAt &&
        (!key || key !== this.finishKeys.get(finishKey))
      )
        return;
      // Re-reading a known finish may enrich its historical activity row, but
      // cannot stop work that subsequently resumed without a new spawn report.
      if (key && key === this.finishKeys.get(finishKey) && !card.endedAt) return;
    }
    // A checklist is metadata. Historical repairs must not wake an agent, move
    // its activity clock or reopen an ended session.
    if (event.kind === 'task.plan.updated') {
      const planKey = cardKey(event.sessionId, event.agentId);
      const scope = this.workScopeAt.get(planKey);
      const scopeId = event.payload.scopeId ?? event.promptId;
      if (event.agentId !== MAIN_AGENT_ID && event.payload.scopeId) {
        const plans =
          this.deferredPlans.get(planKey) ?? new Map<string, MiranteEventOf<'task.plan.updated'>>();
        const previous = plans.get(event.payload.scopeId);
        if (!previous || event.ts >= previous.ts) plans.set(event.payload.scopeId, event);
        if (plans.size > 3) plans.delete(plans.keys().next().value!);
        this.deferredPlans.set(planKey, plans);
      }
      if (scope?.assignmentId && scopeId && scope.assignmentId !== scopeId) return;
      const promptAt = scopeId
        ? this.promptDates.get(cardKey(event.sessionId, event.agentId))?.get(scopeId)
        : undefined;
      if (
        scope &&
        ((promptAt && promptAt < scope.ts) ||
          (event.ts < scope.ts &&
            !(
              (scope.promptId && scopeId === scope.promptId) ||
              (scope.assignmentId && scopeId === scope.assignmentId)
            )))
      )
        return;
      if (
        card.plan &&
        event.ts < card.plan.updatedAt &&
        (!key || key !== this.planKeys.get(planKey))
      )
        return;
      card.plan = {
        ...event.payload,
        steps: event.payload.steps.map((step) => ({ ...step })),
        updatedAt: event.ts,
      };
      if (key) this.planKeys.set(planKey, key);
      else this.planKeys.delete(planKey);
      return;
    }
    this.observeSessionWork(event, lane, card);
    if (card.lastEventAt === undefined || event.ts > card.lastEventAt) card.lastEventAt = event.ts;

    switch (event.kind) {
      case 'agent.metadata.updated': {
        const key = cardKey(event.sessionId, event.agentId);
        const modelAt = this.modelSeenAt.get(key);
        if (event.payload.model && (modelAt === undefined || event.ts >= modelAt)) {
          card.model = event.payload.model;
          this.modelSeenAt.set(key, event.ts);
          if (card.agentId === MAIN_AGENT_ID) lane.model = event.payload.model;
        }
        const effortAt = this.effortSeenAt.get(key);
        if (
          event.payload.effort !== undefined &&
          (effortAt === undefined || event.ts >= effortAt)
        ) {
          if (event.payload.effort === null) delete card.effort;
          else card.effort = event.payload.effort;
          this.effortSeenAt.set(key, event.ts);
        }
        break;
      }

      case 'session.started': {
        if (event.payload.entrypoint !== 'unknown' || lane.entrypoint === 'unknown')
          lane.entrypoint = event.payload.entrypoint;
        if (event.payload.cwd) {
          lane.projectPath = event.payload.cwd;
          lane.projectName = projectNameOf(event.payload.cwd);
        }
        if (event.payload.harness) lane.harness = event.payload.harness;
        const version = event.payload.harnessVersion ?? event.payload.claudeVersion;
        if (version) lane.harnessVersion = version;
        if (event.payload.claudeVersion) lane.claudeVersion = event.payload.claudeVersion;
        if (event.payload.model) lane.model = event.payload.model;
        if (!event.payload.resumed) lane.startedAt = event.ts;
        break;
      }

      case 'session.ended': {
        const workAt = this.sessionWorkAt.get(event.sessionId);
        if ((workAt && workAt > event.ts) || (lane.endedAt && lane.endedAt > event.ts)) break;
        lane.endedAt = event.ts;
        for (const c of lane.cards) {
          if (c.endedAt === undefined) {
            if (!isTerminalState(c.status.state)) c.status = active('done');
            c.endedAt = event.ts;
            c.runningChildren = 0;
            delete c.activity;
            delete c.currentTool;
          }
        }
        break;
      }

      case 'prompt.submitted': {
        const text = requestText(event.payload.preview);
        if (text && event.agentId === MAIN_AGENT_ID) {
          const scopeKey = cardKey(event.sessionId, event.agentId);
          if (event.promptId) {
            const dates = this.promptDates.get(scopeKey) ?? new Map<string, string>();
            dates.set(event.promptId, event.ts);
            this.promptDates.set(scopeKey, dates);
          }
          const scope = this.workScopeAt.get(scopeKey);
          if (!isTaskContinuation(text)) {
            if (scope?.promptId && scope.promptId === event.promptId) {
              if (event.ts < scope.ts) scope.ts = event.ts;
            } else if (!scope || event.ts >= scope.ts) {
              this.workScopeAt.set(scopeKey, { ts: event.ts, promptId: event.promptId });
              delete card.plan;
            }
          }
        }
        if (card.endedAt && event.ts <= card.endedAt) {
          this.push(event, 'prompt', event.payload.preview);
          break;
        }
        card.status = active('thinking');
        // A skill is in use for the request that invoked it. Kept past that, a
        // card would claim a skill from this morning for work it is doing now.
        const promptKey = cardKey(event.sessionId, event.agentId);
        const previous = this.promptedAt.get(promptKey);
        if (previous === undefined || event.ts >= previous) {
          this.promptedAt.set(promptKey, event.ts);
          delete card.activeSkill;
        }
        card.activity = event.payload.preview;
        card.lastActivity = event.payload.preview;
        card.lastActivityKind = 'prompt';
        this.push(event, 'prompt', event.payload.preview);
        break;
      }

      /*
       * The agent in its own words.
       *
       * A board that shows only tool rows reads as a machine log, while the
       * terminal beside it reads as someone explaining what they are doing.
       * This is the same sentence, so the two agree. It clears `activity`: the
       * agent is talking, not running anything, and the next tool call takes
       * the line straight back.
       */
      case 'agent.said': {
        delete card.activity;
        card.lastActivity = event.payload.text;
        card.lastActivityKind = 'said';
        this.push(event, 'said', event.payload.text);
        break;
      }

      case 'agent.started': {
        const startKey = dedupeKeyOf(event) ?? cardKey(event.sessionId, event.agentId);
        // Append-only logs written before assignmentId retain Codex's native
        // turn in the follow-up key. New producers use the normalized field.
        const legacyPrefix = dedupeKeys.agentFollowUp(event.agentId, '');
        const assignmentId =
          event.payload.assignmentId ??
          (event.source === 'codex-rollout' &&
          event.payload.followUp &&
          startKey.startsWith(legacyPrefix)
            ? startKey.slice(legacyPrefix.length) || undefined
            : undefined);
        const firstReport = !this.countedStarts.has(startKey);
        this.countedStarts.add(startKey);
        const assignmentKey = cardKey(event.sessionId, event.agentId);
        const latest = this.assignmentAt.get(assignmentKey);
        if (latest && latest.startKey !== startKey && latest.ts > event.ts) break;
        const alreadyRunning = Boolean(latest) && card.endedAt === undefined;
        const previousParentId = card.parentAgentId ?? MAIN_AGENT_ID;
        this.assignmentAt.set(assignmentKey, { startKey, ts: event.ts });
        if (latest?.startKey === startKey && assignmentId) {
          const scope = this.workScopeAt.get(assignmentKey);
          if (scope && !scope.assignmentId) {
            scope.assignmentId = assignmentId;
            if (event.ts < scope.ts) scope.ts = event.ts;
          }
        }
        if (firstReport && event.payload.followUp) {
          this.workScopeAt.set(assignmentKey, {
            ts: event.ts,
            assignmentId,
          });
          delete card.plan;
          delete card.brief;
          delete card.briefCharCount;
          delete card.briefAvailability;
          delete card.briefTruncated;
          delete card.task;
        }
        if (!latest && firstReport && !this.workScopeAt.has(assignmentKey))
          this.workScopeAt.set(assignmentKey, {
            ts: event.ts,
            assignmentId,
          });
        card.agentType = event.payload.agentType;
        // Kept out of `activity`, which the agent's first tool call overwrites.
        if (event.payload.description) card.task = event.payload.description;
        // What it was actually asked to do, as far as ingest kept it.
        if (event.payload.brief) card.brief = event.payload.brief;
        if (event.payload.briefAvailability && (!card.brief || event.payload.brief))
          card.briefAvailability = event.payload.briefAvailability;
        if (event.payload.briefTruncated !== undefined)
          card.briefTruncated = event.payload.briefTruncated;
        if (event.payload.briefCharCount !== undefined) {
          card.briefCharCount = event.payload.briefCharCount;
        }
        if (event.parentAgentId) card.parentAgentId = event.parentAgentId;
        if (event.payload.model && !this.modelSeenAt.has(cardKey(event.sessionId, event.agentId))) {
          card.model = event.payload.model;
        }
        card.spawnMode = event.payload.spawnMode;
        card.startedAt = event.ts;
        if (event.payload.description) {
          card.lastActivity = event.payload.description;
          delete card.lastActivityKind;
        }

        // A second report of the start can land after the finish — the watcher
        // reads a transcript later than the hook fired. It may correct the
        // details above, but it must not bring a finished agent back to life.
        // Only a start that declares itself a new assignment may do that, once.
        if (firstReport && event.payload.followUp && (!card.endedAt || event.ts > card.endedAt)) {
          delete card.endedAt;
          delete card.stoppedAtLimit;
          delete card.outcome;
          delete card.resultPreview;
          delete card.resultAvailability;
          delete card.resultTruncated;
          delete card.resultCharCount;
        }
        if (card.endedAt === undefined) {
          card.status = active('thinking');
          if (event.payload.description) card.activity = event.payload.description;
        }

        const parent = firstReport && !card.endedAt ? this.parentOf(event) : undefined;
        if (parent) {
          // A new assignment to an already active child is still one child.
          if (!alreadyRunning || previousParentId !== parent.agentId) {
            parent.runningChildren += 1;
            if (alreadyRunning) {
              const previousParent = this.cards.get(cardKey(event.sessionId, previousParentId));
              if (previousParent)
                previousParent.runningChildren = Math.max(0, previousParent.runningChildren - 1);
            }
          }
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
        if (assignmentId) {
          const plan = this.deferredPlans.get(assignmentKey)?.get(assignmentId);
          if (plan) this.apply(plan);
        }
        break;
      }

      case 'agent.finished': {
        // The hook and the transcript both report an end, and the better source
        // is applied over the first. Only the first may count against the
        // parent's running children, or the count goes wrong by one per agent.
        const wasRunning = card.endedAt === undefined;
        card.status = active(event.payload.outcome === 'error' ? 'error' : 'done');
        card.endedAt = event.ts;
        card.outcome = event.payload.outcome;
        if (event.payload.resultPreview) card.resultPreview = event.payload.resultPreview;
        if (
          event.payload.resultAvailability &&
          (!card.resultPreview || event.payload.resultPreview)
        )
          card.resultAvailability = event.payload.resultAvailability;
        if (event.payload.resultTruncated !== undefined)
          card.resultTruncated = event.payload.resultTruncated;
        if (event.payload.resultCharCount !== undefined)
          card.resultCharCount = event.payload.resultCharCount;
        if (key) this.finishKeys.set(cardKey(event.sessionId, event.agentId), key);
        if (event.payload.outcome === 'ok') delete card.stoppedAtLimit;
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
        if (card.endedAt && event.ts <= card.endedAt) {
          this.push(
            event,
            'tool',
            event.payload.summary ?? event.payload.toolName,
            event.payload.toolName,
          );
          break;
        }
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
        const prompted = this.promptedAt.get(cardKey(event.sessionId, event.agentId));
        if (prompted === undefined || event.ts >= prompted)
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
          const delta = this.tokenLedger.apply(event);
          card.tokens = addTokenUsage(card.tokens, delta);
          lane.tokens = addTokenUsage(lane.tokens, delta);
          if (Object.values(delta).some((value) => value !== undefined && value !== 0)) {
            if (!card.usageUpdatedAt || event.ts > card.usageUpdatedAt)
              card.usageUpdatedAt = event.ts;
            if (!lane.usageUpdatedAt || event.ts > lane.usageUpdatedAt)
              lane.usageUpdatedAt = event.ts;
          }
          const key = cardKey(event.sessionId, event.agentId);
          const seen = this.modelSeenAt.get(key);
          if (event.payload.model && (seen === undefined || event.ts >= seen)) {
            card.model = event.payload.model;
            this.modelSeenAt.set(key, event.ts);
          }
        }
        // Native cumulative cost snapshots replace one another; they are never summed.
        if (
          event.payload.costUsd !== undefined &&
          (!lane.costUpdatedAt || event.ts >= lane.costUpdatedAt)
        ) {
          lane.costUsd = event.payload.costUsd;
          lane.costUpdatedAt = event.ts;
          lane.costSource = event.source;
        }
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
        if (card.endedAt) break;
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

  private observeSessionWork(event: MiranteEvent, lane: SessionLane, card: AgentCard): void {
    const beginsWork =
      event.kind === 'session.started' ||
      event.kind === 'prompt.submitted' ||
      event.kind === 'tool.started' ||
      event.kind === 'permission.requested' ||
      (event.kind === 'agent.started' && (!card.endedAt || event.payload.followUp));
    if (!beginsWork || (card.endedAt && event.ts <= card.endedAt)) return;
    const previous = this.sessionWorkAt.get(event.sessionId);
    if (previous === undefined || event.ts > previous)
      this.sessionWorkAt.set(event.sessionId, event.ts);

    // A new prompt/tool can resume a limit-stopped agent before any finish
    // marker was recorded. Keep delayed observations from clearing the limit.
    if (
      event.kind !== 'session.started' &&
      event.kind !== 'agent.started' &&
      (!card.lastEventAt || event.ts > card.lastEventAt)
    ) {
      delete card.stoppedAtLimit;
      delete card.outcome;
      delete card.resultPreview;
      delete card.resultAvailability;
      delete card.resultTruncated;
      delete card.resultCharCount;
    }

    if (lane.endedAt && event.ts > lane.endedAt) {
      delete lane.endedAt;
      const root = this.cards.get(cardKey(event.sessionId, MAIN_AGENT_ID));
      if (root?.endedAt) {
        delete root.endedAt;
        delete root.stoppedAtLimit;
        delete root.outcome;
        delete root.resultPreview;
        delete root.resultAvailability;
        delete root.resultTruncated;
        delete root.resultCharCount;
        root.status = active('idle');
      }
    }
    // A later prompt or tool is evidence that this particular agent resumed.
    // Other completed children keep their end markers and stay in history.
    if (event.kind !== 'agent.started' && card.endedAt && event.ts > card.endedAt) {
      delete card.endedAt;
      delete card.stoppedAtLimit;
      delete card.outcome;
      delete card.resultPreview;
      delete card.resultAvailability;
      delete card.resultTruncated;
      delete card.resultCharCount;
      card.status = active('idle');
    }
  }

  /** Activity reported by agents, before account limits alter the display. */
  hasLiveWork(harness: Harness | undefined, now = Date.now()): boolean {
    return [...this.lanes.values()].some(
      (lane) =>
        (harness === undefined || lane.harness === harness) &&
        !lane.endedAt &&
        lane.cards.some((card) => livenessOf(card, now) === 'live'),
    );
  }

  /**
   * `now` exists for the plan-limit overlay: a reading that said 100% stops
   * meaning anything once its window resets, and only a clock can tell.
   */
  snapshot(now: number = Date.now()): BoardState {
    // Each harness is held to its own plan: Claude Code's reading never stops
    // a Codex card, nor Codex's a Claude Code one.
    const limits = new Map<Harness, WaitingOn | undefined>([
      ['claude-code', this.atPlanLimit(this.planUsage, this.planUsageUpdatedAt, now)],
      ...[...this.harnessPlans].map(
        ([harness, plan]) =>
          [harness, this.atPlanLimit(plan.usage, plan.updatedAt, now)] as [
            Harness,
            WaitingOn | undefined,
          ],
      ),
    ]);
    const sessions = [...this.lanes.values()]
      .map((lane) => ({
        ...lane,
        cards: lane.cards
          .map((card) => {
            const limited = limits.get(lane.harness);
            return limited ? this.withRateLimitOverlay(card, limited) : { ...card };
          })
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
      ...(this.harnessPlans.size > 0
        ? { harnessPlans: Object.fromEntries(this.harnessPlans) as BoardState['harnessPlans'] }
        : {}),
      timeline: [...this.timeline],
      pendingApprovals: [...this.pending.values()],
      ...(this.controlRuns.size ? { controlRuns: [...this.controlRuns.values()] } : {}),
    };
  }

  /**
   * Being at the plan ceiling is a property of the account, not of a card, so it
   * is applied as a display overlay rather than written into card state. That
   * way it disappears by itself when the window resets, with nothing to undo.
   */
  private atPlanLimit(
    usage: PlanUsage | undefined,
    updatedAt: string | undefined,
    now: number,
  ): WaitingOn | undefined {
    const readingAge = updatedAt ? now - Date.parse(updatedAt) : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(readingAge) || readingAge < 0 || readingAge > PLAN_READING_MAX_AGE_MS)
      return undefined;
    // `subject` is a stable key the interface localises; `summary` stays English
    // as the required fallback.
    const windows = [
      ['fiveHour', '5-hour limit', usage?.fiveHour],
      ['sevenDay', 'weekly limit', usage?.sevenDay],
      ['spendLimit', 'spend limit', usage?.spendLimit],
    ] as const;
    for (const [key, label, window] of windows) {
      // A reading of 100% whose window has since reset says nothing about now.
      // Without this, one stale reading from last night marks every card on the
      // board as rate limited this morning — observed.
      if (window?.resetsAt !== undefined && window.resetsAt * 1000 <= now) continue;
      if (window && window.usedPercentage >= RATE_LIMIT_THRESHOLD) {
        return {
          summary: window.resetsAt
            ? `At ${label} — resets ${new Date(window.resetsAt * 1000).toISOString()}`
            : `At ${label}`,
          reason: 'plan_limit',
          subject: key,
          since: updatedAt ?? new Date(now).toISOString(),
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
      harness: 'claude-code',
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
