import type { BoardState } from '@mirante/shared';
import { useI18n } from '../lib/i18n';

/**
 * Explains an empty plan meter, once, where it can be acted on.
 *
 * The meters themselves say "unknown", which is honest but reads as a fault. The
 * actual situation is specific and fixable: plan limits reach only the status
 * line, the status line runs only in the terminal interface, and every session
 * seen so far is running somewhere else.
 */
export const PlanHint = ({ board }: { board: BoardState }) => {
  const { t } = useI18n();

  if (board.planUsage) return null;
  const entrypoints = new Set(board.sessions.map((session) => session.entrypoint));
  if (entrypoints.size === 0 || entrypoints.has('cli')) return null;

  return (
    <aside
      className="flex items-start gap-2.5 rounded-xl border px-4 py-2.5"
      style={{
        background: 'color-mix(in oklab, var(--status-warning) 8%, var(--surface-2))',
        borderColor: 'color-mix(in oklab, var(--status-warning) 30%, var(--hairline))',
      }}
    >
      <span
        aria-hidden="true"
        className="mt-[1px] text-[13px]"
        style={{ color: 'var(--status-warning)' }}
      >
        ⚠
      </span>
      <div className="min-w-0">
        <p className="text-[12px] font-medium text-[var(--text-primary)]">{t('hint.planTitle')}</p>
        <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">{t('hint.planBody')}</p>
        <p className="mt-1 text-[11px] text-[var(--text-muted)]">
          <code
            className="rounded px-1 py-0.5 font-mono"
            style={{ background: 'var(--surface-1)' }}
          >
            claude
          </code>{' '}
          — {t('hint.planAction')}
        </p>
      </div>
    </aside>
  );
};
