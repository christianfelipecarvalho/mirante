import { useEffect, useRef, useState } from 'react';
import type { BoardState } from '@mirante/shared';
import type { Connection, PlanUsageRefresh } from '../lib/client';
import { formatWhen } from '../lib/format';
import { formatLiveCost, formatLiveTokens, summarizeSpend } from '../lib/spend';
import { useI18n } from '../lib/i18n';
import { useNow } from '../lib/now';
import { DisplaySettings } from './DisplaySettings';
import { Icon, type IconName } from './Icon';
import { Logo } from './Logo';
import { HarnessPlanMeters, PlanMeters } from './PlanMeters';

const CONNECTION_META: Record<Connection, { key: string; color: string; icon: IconName }> = {
  connecting: { key: 'conn.connecting', color: 'var(--text-muted)', icon: 'circle' },
  live: { key: 'conn.live', color: 'var(--status-good)', icon: 'dot' },
  offline: { key: 'conn.offline', color: 'var(--status-critical)', icon: 'cross' },
  unauthorized: { key: 'conn.unauthorized', color: 'var(--status-critical)', icon: 'cross' },
};

/** Minimum gap between two passes of the seam, so a burst reads as one arrival. */
const SEAM_MS = 900;

/**
 * Identity and budget, and nothing else.
 *
 * Counts of sessions and agents describe the board, so they live on the board.
 * Display preferences are touched once a week, so they sit behind one control.
 * What remains is the question the header exists to answer at a glance: how
 * much of the plan is left, and what has this cost.
 *
 * Laid out as a grid with named areas rather than a wrapping row: where each
 * group lands is decided here, not by how much width happens to be left over.
 */
export const TopBar = ({
  board,
  connection,
  onRefreshPlanUsage,
  onHome,
}: {
  board: BoardState;
  connection: Connection;
  onRefreshPlanUsage: () => Promise<PlanUsageRefresh>;
  onHome: () => void;
}) => {
  const { t, locale } = useI18n();
  const now = useNow();
  const status = CONNECTION_META[connection];

  const spend = summarizeSpend(board.sessions);
  const costText =
    spend.costUsd === undefined ? t('spend.unknown') : formatLiveCost(spend.costUsd, locale);

  const seam = useSeam(board.lastEventId, connection === 'live');

  return (
    <header className="topbar relative border-b pb-4" style={{ borderColor: 'var(--hairline)' }}>
      {seam > 0 && (
        <span
          key={seam}
          aria-hidden="true"
          className="seam-once pointer-events-none absolute inset-x-0 bottom-[-1px] h-px overflow-hidden"
        />
      )}

      <div className="topbar-grid">
        <button
          type="button"
          onClick={onHome}
          aria-label={t('brand.home')}
          title={t('brand.home')}
          className="brand-home pressable flex cursor-pointer items-center gap-3 rounded-lg text-left"
          style={{ gridArea: 'brand' }}
        >
          <span
            className="grid size-10 shrink-0 place-items-center rounded-xl"
            style={{
              background: 'color-mix(in oklab, var(--accent) 16%, transparent)',
              color: 'var(--accent)',
            }}
          >
            <Logo size={23} />
          </span>
          <span className="block leading-tight">
            <span className="block text-[18px] font-semibold tracking-tight text-[var(--text-primary)]">
              Mirante
            </span>
            <span
              className="flex items-center gap-1 text-[11px]"
              role="status"
              style={{ color: status.color }}
            >
              <Icon name={status.icon} size={10} />
              {t(status.key as 'conn.live')}
            </span>
          </span>
        </button>

        <div className="topbar-cell topbar-limits min-w-0" style={{ gridArea: 'limits' }}>
          {/* One block per account. Claude Code's first: it is the one that can
              be read on demand. */}
          <div className="topbar-plans flex flex-wrap items-start gap-x-6 gap-y-3">
            <PlanMeters board={board} now={now} onRefresh={onRefreshPlanUsage} />
            {board.harnessPlans?.codex && (
              <div
                className="topbar-plan-secondary border-l pl-6"
                style={{ borderColor: 'var(--hairline)' }}
              >
                <HarnessPlanMeters harness="codex" plan={board.harnessPlans.codex} now={now} />
              </div>
            )}
          </div>
        </div>

        <div
          className="topbar-cell topbar-spend min-w-0 text-right leading-tight"
          style={{ gridArea: 'spend' }}
          aria-label={t('spend.label')}
        >
          <details className="group min-w-0 max-w-[20rem]">
            <summary
              className="pressable cursor-pointer list-none rounded py-1 [&::-webkit-details-marker]:hidden"
              aria-label={t('spend.details')}
            >
              <span
                className="tabular block text-[15px] font-semibold [overflow-wrap:anywhere]"
                style={{
                  color: spend.costUsd === undefined ? 'var(--text-muted)' : 'var(--text-primary)',
                }}
              >
                {costText}
              </span>
              <span className="tabular mt-0.5 block text-[11px] text-[var(--text-primary)] [overflow-wrap:anywhere]">
                {t('spend.tokens', { n: formatLiveTokens(spend.tokens, locale) })}
              </span>
              <span className="mt-1 flex items-center justify-end gap-1 text-[10px] text-[var(--text-secondary)]">
                {spend.reportedSessions
                  ? t('spend.coverage', {
                      known: spend.reportedSessions,
                      total: spend.totalSessions,
                    })
                  : t('spend.notReported')}
                <Icon name="disclose" size={10} />
              </span>
            </summary>
            <div
              className="mt-2 space-y-1 border-t pt-2 text-left text-[11px] leading-relaxed text-[var(--text-secondary)] [overflow-wrap:anywhere]"
              style={{ borderColor: 'var(--hairline)' }}
            >
              <p>{t('spend.scope', { n: spend.totalSessions })}</p>
              <p>
                {spend.usageUpdatedAt
                  ? t('spend.tokensUpdated', { at: formatWhen(spend.usageUpdatedAt) })
                  : t('spend.awaitingTokens')}
              </p>
              <p>
                {spend.costUpdatedAt
                  ? t('spend.costUpdated', { at: formatWhen(spend.costUpdatedAt) })
                  : t('spend.awaitingCost')}
              </p>
              <p>{t('spend.sourceHelp')}</p>
            </div>
          </details>
        </div>

        <div className="topbar-cell" style={{ gridArea: 'prefs' }}>
          <DisplaySettings />
        </div>
      </div>
    </header>
  );
};

/**
 * Replays the seam when new events land, at most once per pass.
 *
 * Returns a counter to key the element on; zero means do not draw it.
 */
const useSeam = (lastEventId: number, live: boolean): number => {
  const [pass, setPass] = useState(0);
  const last = useRef(0);
  const seen = useRef(lastEventId);

  useEffect(() => {
    if (!live || lastEventId === seen.current) return;
    seen.current = lastEventId;
    const at = Date.now();
    if (at - last.current < SEAM_MS) return;
    last.current = at;
    setPass((value) => value + 1);
  }, [lastEventId, live]);

  return pass;
};
