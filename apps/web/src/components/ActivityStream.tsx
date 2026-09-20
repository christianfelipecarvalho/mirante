import { useMemo } from 'react';
import type { Step, StepKind, StepStatus } from '../lib/steps';
import { formatClock } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { CATEGORY_GLYPH, describeTool, isPlumbing } from '../lib/tools';

const NON_TOOL_GLYPH: Record<Exclude<StepKind, 'tool'>, string> = {
  prompt: '›',
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
  /** Identity colour per agent, so a mixed stream stays readable. */
  colorOf?: (agentId: string) => string;
};

/**
 * What an agent did, one line per action.
 *
 * Newest first, sorted here rather than with a reversed flex column: a reversed
 * column starts scrolled to its own end, which clips the first row and looks
 * like a rendering fault.
 */
export const ActivityStream = ({ steps, showAgent = false, colorOf }: ActivityStreamProps) => {
  const { t } = useI18n();
  const ordered = useMemo(
    () => [...steps].sort((a, b) => b.ts.localeCompare(a.ts) || b.id - a.id),
    [steps],
  );

  if (ordered.length === 0) {
    return (
      <p className="px-3 py-10 text-center text-[12px] text-[var(--text-muted)]">
        {t('detail.activity.empty')}
      </p>
    );
  }

  return (
    <ol className="p-1.5">
      {ordered.map((step) => (
        <Row
          key={`${step.id}-${step.kind}-${step.title}`}
          step={step}
          showAgent={showAgent}
          colorOf={colorOf}
        />
      ))}
    </ol>
  );
};

const Row = ({
  step,
  showAgent,
  colorOf,
}: {
  step: Step;
  showAgent: boolean;
  colorOf?: ((agentId: string) => string) | undefined;
}) => {
  const { t } = useI18n();
  const isTool = step.kind === 'tool';
  const described = isTool ? describeTool(step.title, step.detail) : undefined;
  const glyph = described
    ? CATEGORY_GLYPH[described.category]
    : NON_TOOL_GLYPH[step.kind as Exclude<StepKind, 'tool'>];
  // Plumbing stays in the record but recedes, so it never competes with work.
  const recessive = isTool && isPlumbing(step.title) && step.status !== 'failed';

  // An agent row whose title is the agent's own type would just repeat the agent
  // column. Say what happened instead, and let the name be the argument.
  const label = step.verb
    ? t(step.verb === 'spawned' ? 'activity.spawned' : 'activity.returned')
    : step.title;
  const primary = step.verb ? step.title : described ? described.primary : (step.detail ?? '');
  const secondary = step.verb ? step.detail : described?.secondary;

  return (
    <li
      className="grid grid-cols-[auto_auto_auto_minmax(0,1fr)_auto] items-baseline gap-x-2.5 rounded px-2 py-[5px] text-[12px] hover:bg-[var(--surface-1)]"
      style={{ opacity: recessive ? 0.55 : 1 }}
    >
      <span className="tabular text-[10px] text-[var(--text-muted)]">{formatClock(step.ts)}</span>

      <span
        aria-hidden="true"
        className={`w-3 text-center ${step.status === 'running' ? 'animate-pulse' : ''}`}
        style={{ color: STATUS_COLOR[step.status] }}
      >
        {glyph}
      </span>

      {showAgent ? (
        <span
          className="max-w-[9rem] truncate text-[10px]"
          style={{ color: colorOf?.(step.agentId) ?? 'var(--text-muted)' }}
        >
          {step.agentId === 'main'
            ? t('card.session')
            : (step.agentType ?? step.agentId.slice(0, 8))}
        </span>
      ) : (
        <span />
      )}

      <span className="flex min-w-0 items-baseline gap-2">
        <span
          className="shrink-0 font-semibold"
          style={{
            color: step.status === 'failed' ? 'var(--status-critical)' : 'var(--text-primary)',
          }}
        >
          {label}
        </span>
        {primary && (
          <span
            className={`min-w-0 truncate text-[var(--text-secondary)] ${!step.verb && described?.mono ? 'font-mono text-[11px]' : ''}`}
            title={step.detail}
          >
            {primary}
          </span>
        )}
        {secondary && (
          <span className="hidden min-w-0 shrink truncate text-[10px] text-[var(--text-muted)] lg:inline">
            {secondary}
          </span>
        )}
      </span>

      <span className="tabular text-[10px] text-[var(--text-muted)]">
        {formatElapsed(step.durationMs)}
      </span>
    </li>
  );
};
