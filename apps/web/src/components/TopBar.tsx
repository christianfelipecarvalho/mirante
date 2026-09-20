import type { BoardState } from '@mirante/shared';
import { addTokenUsage, emptyTokenUsage } from '@mirante/shared';
import type { Connection } from '../lib/client';
import { formatCost, formatTokens } from '../lib/format';
import { Meter } from './Meter';
import { StatTile } from './StatTile';

const CONNECTION_META: Record<Connection, { label: string; color: string; icon: string }> = {
  connecting: { label: 'Connecting', color: 'var(--text-muted)', icon: '○' },
  live: { label: 'Live', color: 'var(--status-good)', icon: '●' },
  offline: { label: 'Daemon offline', color: 'var(--status-critical)', icon: '✕' },
  unauthorized: { label: 'Token rejected', color: 'var(--status-critical)', icon: '✕' },
};

/**
 * Why the plan meters are empty.
 *
 * Plan limits reach one surface only: the status line, which runs in the
 * terminal interface. A board showing nothing but "unknown" invites the reader
 * to assume Mirante is broken, so it says which of the reasons applies.
 */
const planHint = (board: BoardState): string | undefined => {
  if (board.planUsage) return undefined;
  const entrypoints = new Set(board.sessions.map((session) => session.entrypoint));
  if (entrypoints.size > 0 && !entrypoints.has('cli')) {
    return 'no status line outside the terminal';
  }
  return 'needs Pro or Max, after one reply';
};

export const TopBar = ({ board, connection }: { board: BoardState; connection: Connection }) => {
  const active = board.sessions.filter((s) => !s.endedAt);
  const tokens = board.sessions.map((s) => s.tokens).reduce(addTokenUsage, emptyTokenUsage());
  const cost = board.sessions.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
  const agents = board.sessions.reduce(
    (sum, s) => sum + s.cards.filter((c) => c.status.state !== 'done').length,
    0,
  );
  const status = CONNECTION_META[connection];
  const hint = planHint(board);

  return (
    <header
      className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border px-4 py-3"
      style={{ background: 'var(--surface-2)', borderColor: 'var(--hairline)' }}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[15px] font-semibold tracking-tight text-[var(--text-primary)]">
          Mirante
        </span>
        <span className="flex items-center gap-1 text-[11px]" style={{ color: status.color }}>
          <span aria-hidden="true">{status.icon}</span>
          {status.label}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-5">
        <StatTile
          label="Sessions"
          value={String(active.length)}
          hint={`${board.sessions.length} total`}
        />
        <StatTile label="Agents" value={String(agents)} hint="not finished" />
        <StatTile label="Tokens" value={formatTokens(tokens)} hint="all sessions" />
        <StatTile
          label="Cost"
          value={formatCost(cost > 0 ? cost : undefined)}
          hint="all sessions"
        />
      </div>

      <div className="flex min-w-[280px] flex-1 items-start gap-4">
        <Meter
          label="5-hour limit"
          percentage={board.planUsage?.fiveHour?.usedPercentage}
          resetsAt={board.planUsage?.fiveHour?.resetsAt}
          unknownHint={hint}
        />
        <Meter
          label="Weekly limit"
          percentage={board.planUsage?.sevenDay?.usedPercentage}
          resetsAt={board.planUsage?.sevenDay?.resetsAt}
          unknownHint={hint}
        />
        {board.planUsage?.spendLimit && (
          <Meter
            label="Spend limit"
            percentage={board.planUsage.spendLimit.usedPercentage}
            resetsAt={board.planUsage.spendLimit.resetsAt}
          />
        )}
      </div>
    </header>
  );
};
