import { useId, useState } from 'react';
import type { BoardState, Harness } from '@mirante/shared';
import { budgetAssessments, budgetCheckpoint } from '../lib/budget';
import type { Connection } from '../lib/client';
import { useI18n } from '../lib/i18n';
import { Icon } from './Icon';

/** Advice and a recovery export. Observed sessions remain under the person's control. */
export const BudgetAlerts = ({
  board,
  now,
  connection,
}: {
  board: BoardState;
  now: number;
  connection: Connection;
}) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<Harness | undefined>();
  const instructionId = useId();
  const assessments = budgetAssessments(board, now).filter((entry) => entry.level !== 'ok');
  if (assessments.length === 0) return null;

  const download = (harness: Harness) => {
    const blob = new Blob([JSON.stringify(budgetCheckpoint(board, harness, now), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `mirante-${harness}-checkpoint-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <aside aria-label={t('budget.label')} className="shrink-0 space-y-2">
      {assessments.map((assessment) => {
        const unknown = assessment.level === 'unknown' || connection !== 'live';
        const color = unknown
          ? 'var(--text-secondary)'
          : assessment.level === 'warning'
            ? 'var(--status-serious)'
            : 'var(--status-critical)';
        const harness = assessment.harness;
        const open = expanded === harness;
        const id = `${instructionId}-${harness}`;
        return (
          <section
            key={harness}
            className="rounded-lg border px-3 py-2"
            style={{ borderColor: color, background: 'var(--surface-2)' }}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div
                role="status"
                className="flex w-full min-w-0 items-start gap-2 text-[12px] sm:w-auto sm:flex-1"
                style={{ color }}
              >
                <Icon name={unknown ? 'clock' : 'alert'} size={15} className="mt-px shrink-0" />
                <p>
                  <strong>{t(`harness.${harness}`)}: </strong>
                  {unknown ? (
                    t('budget.unknown')
                  ) : (
                    <>
                      {t(`budget.${assessment.level}` as 'budget.warning', {
                        n: Math.round(assessment.remainingPercentage ?? 0),
                      })}{' '}
                      {t(
                        `plan.${assessment.window === 'sevenDay' ? 'weekly' : assessment.window === 'spendLimit' ? 'spend' : 'fiveHour'}`,
                      )}
                      .
                    </>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => download(harness)}
                className="pressable min-h-9 cursor-pointer rounded border border-[var(--hairline)] px-3 text-[12px] text-[var(--text-primary)]"
              >
                {t('budget.save')}
              </button>
              <button
                type="button"
                onClick={() => setExpanded(open ? undefined : harness)}
                aria-expanded={open}
                aria-controls={id}
                className="pressable min-h-9 cursor-pointer rounded px-2 text-[12px] text-[var(--text-primary)]"
              >
                {t('budget.prepare')}
              </button>
            </div>
            {open && (
              <div
                id={id}
                className="mt-2 space-y-2 border-t border-[var(--hairline)] pt-2 text-[12px] text-[var(--text-secondary)]"
              >
                <p>{t('budget.observer')}</p>
                <label className="block" htmlFor={`${id}-prompt`}>
                  {t('budget.instruction')}
                </label>
                <textarea
                  id={`${id}-prompt`}
                  readOnly
                  value={t('budget.prompt')}
                  onFocus={(event) => event.currentTarget.select()}
                  className="min-h-32 w-full resize-y rounded border border-[var(--hairline)] bg-[var(--surface-1)] p-2 text-[12px] leading-relaxed text-[var(--text-primary)]"
                />
                <p>{t('budget.snapshot')}</p>
              </div>
            )}
          </section>
        );
      })}
    </aside>
  );
};
