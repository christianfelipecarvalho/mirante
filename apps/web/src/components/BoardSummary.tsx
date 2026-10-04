import type { Harness } from '@mirante/shared';
import { useI18n } from '../lib/i18n';
import type { BoardSummary as Summary } from '../lib/project-summary';
import { Icon } from './Icon';

/**
 * The board in one line: how much is running right now, across how many
 * projects, with which skills, what waits on the person — and in which coding
 * agent.
 *
 * The harness figures double as the filter between them. They become buttons
 * only when there is more than one harness to choose between; with one, a
 * button would offer a choice that does not exist.
 */
export const BoardSummary = ({
  summary,
  harness,
  onHarness,
}: {
  summary: Summary;
  harness: Harness | 'all';
  onHarness: (harness: Harness | 'all') => void;
}) => {
  const { t } = useI18n();
  const running =
    summary.running === 0
      ? t('summary.none')
      : summary.running === 1
        ? t('summary.runningOne')
        : summary.projectsRunning === 1
          ? t('summary.runningOneProject', { n: summary.running })
          : t('summary.running', { n: summary.running, p: summary.projectsRunning });
  const present = summary.harnesses.filter(
    (entry) => entry.sessions > 0 || entry.harness === harness,
  );
  const choosable = present.length > 1;

  return (
    <div
      className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-[var(--text-secondary)]"
      aria-label={t('summary.label')}
      role="group"
    >
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          style={{ color: summary.running > 0 ? 'var(--accent)' : 'var(--text-muted)' }}
        >
          <Icon name="agents" size={14} />
        </span>
        <span className={summary.running > 0 ? 'text-[var(--text-primary)]' : ''}>{running}</span>
      </span>

      {summary.skills > 0 && (
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="text-[var(--text-muted)]">
            <Icon name="skill" size={12} />
          </span>
          {summary.skills === 1
            ? t('summary.skillsOne')
            : t('summary.skills', { n: summary.skills })}
        </span>
      )}

      {summary.awaiting > 0 && (
        <span
          className="flex items-center gap-1.5 font-medium"
          style={{ color: 'var(--status-warning)' }}
        >
          <Icon name="alert" size={13} />
          {t('summary.awaiting', { n: summary.awaiting })}
        </span>
      )}

      {present.length > 0 && (
        <div
          className="flex items-center gap-1.5 sm:ml-auto"
          role="group"
          aria-label={t('summary.harnessFilter')}
        >
          {present.map((entry) => {
            const name = t(`harness.${entry.harness}`);
            const label = (
              <>
                <Icon name="harness" size={12} />
                {name}
                <span className="tabular text-[11px] text-[var(--text-muted)]">
                  {entry.sessions}
                </span>
              </>
            );
            const described = t('summary.harnessCount', { n: entry.sessions, h: name });
            if (!choosable) {
              return (
                <span
                  key={entry.harness}
                  title={described}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px]"
                  style={{ background: 'var(--surface-1)' }}
                >
                  {label}
                </span>
              );
            }
            const selected = harness === entry.harness;
            return (
              <button
                key={entry.harness}
                type="button"
                aria-pressed={selected}
                title={selected ? t('summary.harnessOnly', { h: name }) : described}
                onClick={() => onHarness(selected ? 'all' : entry.harness)}
                className="pressable flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors duration-200"
                style={{
                  // Selection is fill and border together, never a hue alone.
                  background: selected ? 'var(--surface-1)' : 'transparent',
                  borderColor: selected ? 'var(--accent)' : 'var(--hairline)',
                  color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
