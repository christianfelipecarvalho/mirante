import type { SpawnMode } from './agent.js';
import type { EffortLevel } from './effort.js';
import type { Entrypoint, Harness } from './kinds.js';
import type { CardStatus } from './state.js';
import type { ContextUsage, PlanUsage, TokenUsage } from './usage.js';

/** The plan limits of one harness other than Claude Code, and when they were read. */
export type HarnessPlan = {
  usage: PlanUsage;
  /** ISO 8601. When the harness wrote the reading. */
  updatedAt: string;
  planType?: string;
};

/** What a tool call looks like while it is still running. */
export type RunningTool = {
  toolUseId: string;
  toolName: string;
  summary: string;
  startedAt: string;
};

/** One card on the board: the session's root agent, or a subagent. */
export type AgentCard = {
  agentId: string;
  sessionId: string;
  agentType?: string;
  /**
   * What this agent was actually asked to do.
   *
   * An agent's type is often generic — three subagents can all be
   * "general-purpose" while one is the designer, one the architect and one the
   * PM. The task is the only thing on the card that tells them apart, so it is
   * kept separately from activity, which the first tool call would overwrite.
   */
  task?: string;
  /**
   * The instruction this agent was given, as far as the board kept it.
   *
   * The task is a headline a caller typed; this is what was actually asked. It
   * is the most literal answer the board has to "what is this agent doing",
   * which is the question the product exists to answer.
   */
  brief?: string;
  /** The brief's length before truncation, when it was cut. */
  briefCharCount?: number;
  parentAgentId?: string;
  status: CardStatus;
  /** The single line under the card title: what this agent is doing right now. */
  activity?: string;
  /**
   * The last thing this agent did, kept after it finishes.
   *
   * Without it a card goes blank the moment a tool returns, which is most of the
   * time a card is looked at — "Thinking" on its own answers nothing.
   */
  lastActivity?: string;
  /**
   * Set when `lastActivity` is what the person typed, rather than something the
   * agent did. The interface quotes it and says "your last message"; building
   * a "Prompt: …" string here would fix it in one language.
   */
  lastActivityKind?: 'prompt' | 'said';
  currentTool?: RunningTool;
  activeSkill?: string;
  model?: string;
  effort?: EffortLevel;
  spawnMode?: SpawnMode;
  tokens: TokenUsage;
  startedAt: string;
  endedAt?: string;
  /**
   * Subagents launched by this card that have not finished.
   *
   * Async children do not block the parent, so they cannot be represented as a
   * waiting state. They are a count badge instead. See docs/EVENT_MAP.md §6 D3.
   */
  runningChildren: number;
  /**
   * Set when the card stopped because a plan limit refused the request.
   *
   * "Turn ended with an error" is true and useless: the actual answer is which
   * window, and when it reopens — which is also when the work can resume.
   */
  stoppedAtLimit?: { window?: string; resetsAt?: number };
  /**
   * ISO 8601. The last event this card received, from any source.
   *
   * A card's state is only as good as the last signal behind it. When a finish
   * is lost — a hook fired while the daemon was down — a card says "running"
   * forever; this is what lets the interface notice it has gone quiet.
   */
  lastEventAt?: string;
};

/** One session: a lane on the board. */
export type SessionLane = {
  sessionId: string;
  projectPath: string;
  /** Last path segment, for the lane header. */
  projectName: string;
  gitBranch?: string;
  entrypoint: Entrypoint;
  /** Which coding agent runs it. Claude Code unless a session said otherwise. */
  harness: Harness;
  harnessVersion?: string;
  claudeVersion?: string;
  model?: string;
  startedAt: string;
  endedAt?: string;
  tokens: TokenUsage;
  costUsd?: number;
  context?: ContextUsage;
  /** Root card first, then subagents in spawn order. */
  cards: AgentCard[];
};

export type TimelineKind =
  | 'prompt'
  | 'said'
  | 'handoff.start'
  | 'handoff.end'
  | 'tool'
  | 'tool.failed'
  | 'skill'
  | 'compaction'
  | 'permission'
  | 'error';

export type TimelineEntry = {
  /** The event id it came from, so the timeline is replayable and stable. */
  id: number;
  ts: string;
  sessionId: string;
  agentId: string;
  agentType?: string;
  kind: TimelineKind;
  /** Already rendered and redacted. The UI displays it, it does not build it. */
  text: string;
  /**
   * The thing the row is about — a tool name, an agent, a decision.
   *
   * Rows whose text is a bare label are localised by the UI from `kind` plus
   * this; rows carrying real content, like a command or a prompt, use `text`.
   */
  subject?: string;
  /**
   * The underlying fact this row stands for, when two sources can report it.
   * A later, better-sourced report replaces this row instead of adding one.
   */
  dedupeKey?: string;
};

export type PendingApproval = {
  requestId: string;
  sessionId: string;
  agentId: string;
  toolName: string;
  inputPreview: string;
  requestedAt: string;
  /**
   * When the daemon stops waiting and answers `ask`, handing the question to the
   * terminal. The UI counts down to this, because after it the click does nothing.
   */
  decideBy: string;
};

export type BoardState = {
  /** Highest event id folded in. Clients resume from here. */
  lastEventId: number;
  sessions: SessionLane[];
  /** Plan limits are per account, not per session, so they live at the board level. */
  planUsage?: PlanUsage;
  planUsageUpdatedAt?: string;
  /**
   * Plan limits of the other harnesses, by harness. Claude Code's stay in
   * `planUsage`, where every earlier client already reads them.
   */
  harnessPlans?: Partial<Record<Exclude<Harness, 'claude-code'>, HarnessPlan>>;
  timeline: TimelineEntry[];
  pendingApprovals: PendingApproval[];
};

export const emptyBoard = (): BoardState => ({
  lastEventId: 0,
  sessions: [],
  timeline: [],
  pendingApprovals: [],
});
