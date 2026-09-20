import type { MiranteEvent, SessionLane } from '@mirante/shared';
import { formatTokens, formatWhen } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { Icon } from './Icon';
import { latestTurn } from '../lib/turns';

export type LatestRequestProps = {
  events: MiranteEvent[];
  sessions: SessionLane[];
  onOpen: (sessionId: string) => void;
};

/**
 * The thing the person most recently asked for, kept at the top.
 *
 * Everything else on the board answers "what is running". This answers "what did
 * I ask for", which is the question you have when you come back to the screen.
 */
export const LatestRequest = ({ events, sessions, onOpen }: LatestRequestProps) => {
  const { t } = useI18n();
  const latest = latestTurn(events);

  if (!latest || !latest.turn.prompt) return null;

  const lane = sessions.find((session) => session.sessionId === latest.sessionId);
  const { turn } = latest;

  return (
    <button
      type="button"
      onClick={() => onOpen(latest.sessionId)}
      className="w-full rounded-xl border px-4 py-3 text-left transition-colors hover:border-[var(--accent)]"
      style={{ background: 'var(--surface-2)', borderColor: 'var(--hairline)' }}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
          <Icon name="prompt" size={12} />
          {t('latest.title')}
        </span>
        {lane && (
          <span className="text-[11px] text-[var(--text-secondary)]">
            {t('latest.in', { project: lane.projectName })}
          </span>
        )}
        <span className="tabular text-[11px] text-[var(--text-muted)]">
          {formatWhen(turn.startedAt)}
        </span>
        <span className="ml-auto flex items-center gap-3 text-[11px] text-[var(--text-muted)]">
          <span className="tabular">
            {turn.agentsSpawned} {t('detail.agentsSpawned').toLowerCase()}
          </span>
          <span className="tabular">
            {turn.toolsRun} {t('detail.toolsRun').toLowerCase()}
          </span>
          <span className="tabular">
            {formatTokens(turn.tokens)} {t('card.tokens')}
          </span>
        </span>
      </div>
      <p className="mt-1.5 line-clamp-2 text-[14px] text-[var(--text-primary)]">{turn.prompt}</p>
    </button>
  );
};
