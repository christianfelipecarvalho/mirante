import {
  livenessOf,
  SILENT_AFTER_MS,
  type BoardState,
  type Harness,
  type PlanUsage,
} from '@mirante/shared';

/** Policy margins, not a prediction of credits or work needed to finish. */
export const BUDGET_WARNING_PERCENT = 80;
export const BUDGET_HANDOFF_PERCENT = 90;
export const BUDGET_READING_MAX_AGE_MS = 5 * 60_000;

export type BudgetAssessment = {
  harness: Harness;
  level: 'ok' | 'unknown' | 'warning' | 'critical' | 'exhausted';
  reason?: 'missing' | 'stale' | 'reset';
  window?: keyof PlanUsage;
  usedPercentage?: number;
  remainingPercentage?: number;
};

/** Account windows are shared by all children; never add their percentages. */
export const assessBudget = (
  harness: Harness,
  usage: PlanUsage | undefined,
  updatedAt: string | undefined,
  now: number,
): BudgetAssessment => {
  const unknown = (reason: BudgetAssessment['reason']): BudgetAssessment => ({
    harness,
    level: 'unknown',
    reason,
  });
  const readAt = updatedAt === undefined ? NaN : Date.parse(updatedAt);
  if (!usage || !Number.isFinite(readAt)) return unknown('missing');
  if (readAt > now || now - readAt > BUDGET_READING_MAX_AGE_MS) return unknown('stale');

  const windows = Object.entries(usage) as [
    keyof PlanUsage,
    NonNullable<PlanUsage[keyof PlanUsage]>,
  ][];
  const live = windows.filter(
    ([, window]) =>
      Number.isFinite(window.usedPercentage) &&
      window.usedPercentage >= 0 &&
      (window.resetsAt === undefined || window.resetsAt * 1000 > now),
  );
  if (live.length === 0) return unknown(windows.length > 0 ? 'reset' : 'missing');
  const [window, reading] = live.reduce((worst, entry) =>
    entry[1].usedPercentage > worst[1].usedPercentage ? entry : worst,
  );
  const used = reading.usedPercentage;
  return {
    harness,
    level:
      used >= 100
        ? 'exhausted'
        : used >= BUDGET_HANDOFF_PERCENT
          ? 'critical'
          : used >= BUDGET_WARNING_PERCENT
            ? 'warning'
            : 'ok',
    window,
    usedPercentage: used,
    remainingPercentage: Math.max(0, 100 - used),
  };
};

export const budgetAssessments = (board: BoardState, now: number): BudgetAssessment[] => {
  const active = new Set(
    board.sessions
      .filter(
        (session) =>
          !session.endedAt &&
          session.cards.some((card) => {
            if (livenessOf(card, now) === 'live') return true;
            const last = Date.parse(card.lastEventAt ?? card.startedAt);
            // A quota overlay hides work; retain advice while that signal is recent.
            return (
              card.status.state === 'rate_limited' &&
              !card.endedAt &&
              Number.isFinite(last) &&
              now >= last &&
              now - last <= SILENT_AFTER_MS
            );
          }),
      )
      .map((session) => session.harness),
  );
  return [...active].map((harness) => {
    const plan =
      harness === 'claude-code'
        ? { usage: board.planUsage, updatedAt: board.planUsageUpdatedAt }
        : board.harnessPlans?.[harness];
    return assessBudget(harness, plan?.usage, plan?.updatedAt, now);
  });
};

/** Factual recovery snapshot. Idle/error states do not establish task completion. */
export const budgetCheckpoint = (board: BoardState, harness: Harness, now: number) => ({
  version: 1,
  capturedAt: new Date(now).toISOString(),
  harness,
  budget:
    harness === 'claude-code'
      ? assessBudget(harness, board.planUsage, board.planUsageUpdatedAt, now)
      : assessBudget(
          harness,
          board.harnessPlans?.[harness]?.usage,
          board.harnessPlans?.[harness]?.updatedAt,
          now,
        ),
  executionPaused: false,
  scope:
    'Observed state only. Task completion, tests and remaining work require confirmation by the coordinator.',
  sessions: board.sessions
    .filter((session) => session.harness === harness && !session.endedAt)
    .map((session) => ({
      sessionId: session.sessionId,
      projectPath: session.projectPath,
      gitBranch: session.gitBranch,
      latestRequest: board.timeline
        .filter(
          (entry) =>
            entry.sessionId === session.sessionId &&
            entry.agentId === 'main' &&
            entry.kind === 'prompt',
        )
        .sort((a, b) => a.ts.localeCompare(b.ts))
        .at(-1)?.text,
      agents: session.cards.map((card) => ({
        agentId: card.agentId,
        parentAgentId: card.parentAgentId,
        task: card.task,
        brief: card.brief,
        briefCharCount: card.briefCharCount,
        state: card.status.state,
        completion: card.status.state === 'done' ? 'reported_done' : 'unconfirmed',
        waitingOn: card.status.waitingOn,
        activity: card.activity ?? card.lastActivity,
        lastEventAt: card.lastEventAt,
      })),
      pendingApprovals: board.pendingApprovals.filter(
        (approval) => approval.sessionId === session.sessionId,
      ),
    })),
});
