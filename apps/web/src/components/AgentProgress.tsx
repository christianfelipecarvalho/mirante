import type { AgentCard, WorkPlan } from '@mirante/shared';
import { completionOf, isWaitingState, livenessOf, workProgress } from '@mirante/shared';
import { useI18n } from '../lib/i18n';
import type { BadgeOverride } from './StateBadge';
import './TaskProgress.css';

export type TaskProgressProps = {
  card?: AgentCard;
  plan?: WorkPlan;
  now: number;
  sessionEnded?: boolean;
};

/** Execution state never changes the completed-step count. */
export const agentProgressState = (
  card: AgentCard | undefined,
  now: number,
  sessionEnded = false,
) => {
  if (!card) return { tone: 'neutral', override: undefined };
  const completion = completionOf(card);
  const liveness = livenessOf(card, now, sessionEnded);
  const override: BadgeOverride | undefined =
    completion === 'interrupted'
      ? 'interrupted'
      : completion === 'unknown'
        ? 'unconfirmed'
        : !completion && liveness === 'silent'
          ? 'silent'
          : undefined;
  const tone =
    completion === 'failed'
      ? 'failed'
      : completion === 'interrupted' || isWaitingState(card.status.state)
        ? 'waiting'
        : override === 'silent' || override === 'unconfirmed'
          ? 'quiet'
          : liveness === 'live' && !card.endedAt
            ? 'working'
            : 'neutral';
  return { tone, override };
};

/** A geometric summary of recorded steps, never an elapsed-time estimate.
 * Unknown/partial plans have no arc and no numeric zero. */
export const AgentProgress = ({
  card,
  plan: explicitPlan,
  now,
  sessionEnded = false,
}: TaskProgressProps) => {
  const { t } = useI18n();
  const plan = explicitPlan ?? card?.plan;
  const progress = workProgress(plan);
  const known = progress.percent !== undefined;
  const label = known
    ? t('progress.circleKnown', {
        percent: progress.percent!,
        completed: progress.completed,
        total: progress.total,
      })
    : plan?.completeness === 'partial'
      ? t('progress.circlePartial', { completed: progress.completed, total: progress.total })
      : t('progress.circleUnknown');
  const state = agentProgressState(card, now, sessionEnded);
  return (
    <span
      className="agent-progress"
      role="img"
      aria-label={label}
      title={label}
      data-known={known}
      data-tone={state.tone}
      data-complete={progress.percent === 100}
    >
      <svg viewBox="0 0 36 36" aria-hidden="true" focusable="false">
        <circle
          className="agent-progress-track"
          cx="18"
          cy="18"
          r="15"
          fill="none"
          strokeWidth="2.5"
          strokeDasharray={known ? undefined : '2 3'}
        />
        {known && (
          <circle
            className="agent-progress-arc"
            cx="18"
            cy="18"
            r="15"
            fill="none"
            strokeWidth="2.5"
            pathLength="100"
            strokeDasharray="100"
            strokeDashoffset={100 - progress.percent!}
            transform="rotate(-90 18 18)"
          />
        )}
      </svg>
      <span className="agent-progress-value tabular" aria-hidden="true">
        {known ? progress.percent : '—'}
        {known && <span>%</span>}
      </span>
    </span>
  );
};
