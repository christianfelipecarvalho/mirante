import type { Step, StepKind, StepStatus } from '../lib/steps';
import { formatClock } from '../lib/format';
import { useI18n } from '../lib/i18n';

const KIND_GLYPH: Record<StepKind, string> = {
  prompt: '›',
  tool: '▸',
  agent: '⇢',
  skill: '✦',
  permission: '⚠',
  compaction: '⋯',
  error: '✕',
};

const STATUS_COLOR: Record<StepStatus, string> = {
  running: 'var(--accent)',
  ok: 'var(--text-muted)',
  failed: 'var(--status-critical)',
  info: 'var(--text-secondary)',
};

const formatElapsed = (ms: number | undefined): string => {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
};

export type ActivityStreamProps = {
  steps: Step[];
  /** Shown beside each line when the stream mixes several agents. */
  showAgent?: boolean;
};

/**
 * What an agent did, one line per action.
 *
 * Reads like a log because that is what a person wants when they open an agent,
 * but each line is a whole action — tool, argument, outcome, elapsed — rather
 * than the raw start-and-finish pair the event stream actually carries.
 */
export const ActivityStream = ({ steps, showAgent = false }: ActivityStreamProps) => {
  const { t } = useI18n();

  if (steps.length === 0) {
    return (
      <p className="px-3 py-8 text-center text-[12px] text-[var(--text-muted)]">
        {t('detail.activity.empty')}
      </p>
    );
  }

  return (
    <ol className="flex flex-col-reverse gap-px p-2 font-mono text-[12px]">
      {steps.map((step) => (
        <li
          key={`${step.id}-${step.kind}-${step.title}`}
          className="flex items-baseline gap-2 rounded px-2 py-1 hover:bg-[var(--surface-2)]"
        >
          <span className="tabular shrink-0 text-[10px] text-[var(--text-muted)]">
            {formatClock(step.ts)}
          </span>
          <span
            aria-hidden="true"
            className={`shrink-0 ${step.status === 'running' ? 'animate-pulse' : ''}`}
            style={{ color: STATUS_COLOR[step.status] }}
          >
            {KIND_GLYPH[step.kind]}
          </span>
          {showAgent && (
            <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
              {step.agentType ?? step.agentId.slice(0, 8)}
            </span>
          )}
          <span
            className="shrink-0 font-semibold"
            style={{
              color: step.status === 'failed' ? 'var(--status-critical)' : 'var(--text-primary)',
            }}
          >
            {step.title}
          </span>
          {step.detail && (
            <span
              className="min-w-0 flex-1 truncate text-[var(--text-secondary)]"
              title={step.detail}
            >
              {step.detail}
            </span>
          )}
          <span className="tabular ml-auto shrink-0 text-[10px] text-[var(--text-muted)]">
            {formatElapsed(step.durationMs)}
          </span>
        </li>
      ))}
    </ol>
  );
};
