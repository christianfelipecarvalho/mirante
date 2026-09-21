import { useEffect, useRef, useState } from 'react';
import type { BoardState } from '@mirante/shared';
import { addTokenUsage, emptyTokenUsage, totalTokens } from '@mirante/shared';
import type { Connection, PlanUsageRefresh } from '../lib/client';
import { compactNumber, formatCost } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useNow } from '../lib/now';
import { DisplaySettings } from './DisplaySettings';
import { Icon, type IconName } from './Icon';
import { Logo } from './Logo';
import { PlanMeters } from './PlanMeters';

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
}: {
  board: BoardState;
  connection: Connection;
  onRefreshPlanUsage: () => Promise<PlanUsageRefresh>;
}) => {
  const { t } = useI18n();
  const now = useNow();
  const status = CONNECTION_META[connection];

  const tokens = board.sessions
    .map((session) => session.tokens)
    .reduce(addTokenUsage, emptyTokenUsage());
  const costed = board.sessions.filter((session) => session.costUsd !== undefined);
  const cost = costed.reduce((sum, session) => sum + (session.costUsd ?? 0), 0);
  // Cost reaches Mirante only through the status line, so an editor-only
  // session has none. Summing it as $0 would understate the total silently.
  const costText = costed.length === 0 ? t('spend.unknown') : formatCost(cost);
  const partial = costed.length > 0 && costed.length < board.sessions.length;

  const seam = useSeam(board.lastEventId, connection === 'live');

  return (
    <header className="topbar relative border-b pb-3" style={{ borderColor: 'var(--hairline)' }}>
      {seam > 0 && (
        <span
          key={seam}
          aria-hidden="true"
          className="seam-once pointer-events-none absolute inset-x-0 bottom-[-1px] h-px overflow-hidden"
        />
      )}

      <div className="topbar-grid">
        <div className="flex items-center gap-2.5" style={{ gridArea: 'brand' }}>
          <span
            className="grid size-8 shrink-0 place-items-center rounded-lg"
            style={{
              background: 'color-mix(in oklab, var(--accent) 16%, transparent)',
              color: 'var(--accent)',
            }}
          >
            <Logo size={19} />
          </span>
          <div className="leading-tight">
            <div className="text-[15px] font-semibold tracking-tight text-[var(--text-primary)]">
              Mirante
            </div>
            <div className="flex items-center gap-1 text-[11px]" style={{ color: status.color }}>
              <Icon name={status.icon} size={10} />
              {t(status.key as 'conn.live')}
            </div>
          </div>
        </div>

        <div className="topbar-cell topbar-limits min-w-0" style={{ gridArea: 'limits' }}>
          <PlanMeters board={board} now={now} onRefresh={onRefreshPlanUsage} />
        </div>

        <div
          className="topbar-cell topbar-spend text-right leading-tight"
          style={{ gridArea: 'spend' }}
          aria-label={t('spend.label')}
        >
          <div>
            <div
              className="tabular text-[15px] font-semibold"
              style={{ color: costed.length === 0 ? 'var(--text-muted)' : 'var(--text-primary)' }}
            >
              {costText}
              {partial && (
                <span className="ml-1.5 text-[10px] font-normal text-[var(--text-muted)]">
                  {t('spend.partial')}
                </span>
              )}
            </div>
            <div className="tabular mt-0.5 text-[11px] text-[var(--text-muted)]">
              {t('spend.tokens', { n: compactNumber(totalTokens(tokens)) })}
            </div>
          </div>
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
