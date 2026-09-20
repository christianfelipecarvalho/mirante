import type { BoardState } from '@mirante/shared';
import { addTokenUsage, emptyTokenUsage } from '@mirante/shared';
import type { Connection } from '../lib/client';
import { formatCost, formatTokens } from '../lib/format';
import { LOCALES, LOCALE_LABEL, useI18n } from '../lib/i18n';
import { Meter } from './Meter';
import { StatTile } from './StatTile';

const CONNECTION_META: Record<Connection, { key: string; color: string; icon: string }> = {
  connecting: { key: 'conn.connecting', color: 'var(--text-muted)', icon: '○' },
  live: { key: 'conn.live', color: 'var(--status-good)', icon: '●' },
  offline: { key: 'conn.offline', color: 'var(--status-critical)', icon: '✕' },
  unauthorized: { key: 'conn.unauthorized', color: 'var(--status-critical)', icon: '✕' },
};

/**
 * Why the plan meters are empty.
 *
 * Plan limits reach one surface only: the status line, which runs in the
 * terminal interface. A board showing nothing but "unknown" invites the reader
 * to assume Mirante is broken, so it says which of the reasons applies.
 */
const planHintKey = (
  board: BoardState,
): 'plan.hint.editorOnly' | 'plan.hint.needsPlan' | undefined => {
  if (board.planUsage) return undefined;
  const entrypoints = new Set(board.sessions.map((session) => session.entrypoint));
  if (entrypoints.size > 0 && !entrypoints.has('cli')) return 'plan.hint.editorOnly';
  return 'plan.hint.needsPlan';
};

export const TopBar = ({ board, connection }: { board: BoardState; connection: Connection }) => {
  const { t, locale, setLocale } = useI18n();
  const active = board.sessions.filter((session) => !session.endedAt);
  const tokens = board.sessions
    .map((session) => session.tokens)
    .reduce(addTokenUsage, emptyTokenUsage());
  const cost = board.sessions.reduce((sum, session) => sum + (session.costUsd ?? 0), 0);
  const agents = board.sessions.reduce(
    (sum, session) => sum + session.cards.filter((card) => card.status.state !== 'done').length,
    0,
  );
  const status = CONNECTION_META[connection];
  const hintKey = planHintKey(board);
  const hint = hintKey ? t(hintKey) : undefined;

  return (
    <header
      className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border px-4 py-3"
      style={{ background: 'var(--surface-2)', borderColor: 'var(--hairline)' }}
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="grid size-7 place-items-center rounded-lg text-[14px]"
          style={{
            background: 'color-mix(in oklab, var(--accent) 18%, transparent)',
            color: 'var(--accent)',
          }}
        >
          ⌂
        </span>
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-semibold tracking-tight text-[var(--text-primary)]">
              Mirante
            </span>
            <span className="flex items-center gap-1 text-[11px]" style={{ color: status.color }}>
              <span
                aria-hidden="true"
                className={connection === 'live' ? 'animate-pulse' : undefined}
              >
                {status.icon}
              </span>
              {t(status.key as 'conn.live')}
            </span>
          </div>
          <div className="text-[10px] text-[var(--text-muted)]">{t('brand.tagline')}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-5">
        <StatTile
          label={t('stat.sessions')}
          value={String(active.length)}
          hint={t('stat.sessions.hint', { count: board.sessions.length })}
        />
        <StatTile label={t('stat.agents')} value={String(agents)} hint={t('stat.agents.hint')} />
        <StatTile
          label={t('stat.tokens')}
          value={formatTokens(tokens)}
          hint={t('stat.allSessions')}
        />
        <StatTile
          label={t('stat.cost')}
          value={formatCost(cost > 0 ? cost : undefined)}
          hint={t('stat.allSessions')}
        />
      </div>

      <div className="flex min-w-[280px] flex-1 items-start gap-4">
        <Meter
          label={t('plan.fiveHour')}
          percentage={board.planUsage?.fiveHour?.usedPercentage}
          resetsAt={board.planUsage?.fiveHour?.resetsAt}
          unknownHint={hint}
        />
        <Meter
          label={t('plan.weekly')}
          percentage={board.planUsage?.sevenDay?.usedPercentage}
          resetsAt={board.planUsage?.sevenDay?.resetsAt}
          unknownHint={hint}
        />
        {board.planUsage?.spendLimit && (
          <Meter
            label={t('plan.spend')}
            percentage={board.planUsage.spendLimit.usedPercentage}
            resetsAt={board.planUsage.spendLimit.resetsAt}
          />
        )}
      </div>

      <div className="flex items-center gap-1" role="group" aria-label="Language">
        {LOCALES.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setLocale(option)}
            className="rounded px-2 py-1 text-[11px] font-medium transition-colors"
            style={{
              background: locale === option ? 'var(--surface-1)' : 'transparent',
              color: locale === option ? 'var(--text-primary)' : 'var(--text-muted)',
            }}
          >
            {LOCALE_LABEL[option]}
          </button>
        ))}
      </div>
    </header>
  );
};
