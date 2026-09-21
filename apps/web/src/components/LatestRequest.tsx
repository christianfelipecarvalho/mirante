import type { MiranteEvent, SessionLane } from '@mirante/shared';
import { MAIN_AGENT_ID } from '@mirante/shared';
import { formatCost, formatSpan, formatTokens } from '../lib/format';
import { useI18n, type Translate } from '../lib/i18n';
import { latestRequest } from '../lib/turns';
import { waitingText } from './AgentCard';
import { Icon } from './Icon';
import { STATE_META, StateBadge } from './StateBadge';

export type LatestRequestProps = {
  events: MiranteEvent[];
  sessions: SessionLane[];
  now: number;
  onOpen: (sessionId: string) => void;
};

const ago = (ms: number, t: Translate): string => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return t('plan.ago.justNow');
  return minutes < 60
    ? t('plan.ago.minutes', { n: minutes })
    : t('plan.ago.hours', { n: Math.round(minutes / 60) });
};

/**
 * The thing the person most recently asked for.
 *
 * Everything else on the board answers "what is running". This answers "what
 * did I ask for, and is it done", which is the question you have when you come
 * back to the screen. So it leads with the project, says the state in a word,
 * and says how long — not at what time, which would leave the arithmetic to the
 * reader.
 *
 * When the latest thing typed was only "Continue" or "sim", the headline is the
 * request it continues; the follow-ups are acknowledged on a line of their own
 * and counted in the cost.
 *
 * A bar, not a card: only session lanes are cards, so the page has one kind of
 * box and this reads as a status line above them.
 */
export const LatestRequest = ({ events, sessions, now, onOpen }: LatestRequestProps) => {
  const { t } = useI18n();
  const latest = latestRequest(events);
  if (!latest || !latest.turn.prompt) return null;

  const { turn, followUps } = latest;
  const lane = sessions.find((session) => session.sessionId === latest.sessionId);
  const main = lane?.cards.find((card) => card.agentId === MAIN_AGENT_ID);
  // The lane's main card is the authority on whether the request is still
  // going; a turn only learns it closed when a later one starts.
  const status = lane?.endedAt || !main ? { state: 'done' as const } : main.status;
  const finished = status.state === 'done' || status.state === 'error';
  const rail = STATE_META[status.state].color;

  const when = finished
    ? t('latest.doneAgo', { ago: ago(now - Date.parse(latest.endedAt), t) })
    : t('latest.for', { d: formatSpan(now - Date.parse(latest.startedAt)) });

  const lastFollowUp = followUps.at(-1)?.prompt;
  const followedBy =
    followUps.length === 1 && lastFollowUp
      ? t('latest.followedByOne', { text: lastFollowUp })
      : followUps.length > 1 && lastFollowUp
        ? t('latest.followedByMany', { n: followUps.length, text: lastFollowUp })
        : undefined;
  const includes =
    followUps.length === 0
      ? undefined
      : followUps.length === 1
        ? t('latest.includesOne')
        : t('latest.includesMany', { n: followUps.length });

  return (
    <button
      // Keyed on the request, not the follow-up: typing "sim" is not a new
      // request, so it does not replay the arrival.
      key={turn.promptId}
      type="button"
      onClick={() => onOpen(latest.sessionId)}
      title={`${t('latest.openSession')} — ${new Date(turn.startedAt).toLocaleString()}`}
      className="arrive group grid w-full cursor-pointer grid-cols-[3px_minmax(0,1fr)_auto] gap-x-3 rounded-lg py-2 pr-3 text-left transition-colors duration-200 hover:bg-[var(--surface-2)]"
    >
      <span className="sr-only">{t('latest.title')}</span>
      <span
        aria-hidden="true"
        className={`${followedBy ? 'row-span-3' : 'row-span-2'} rounded-full`}
        style={{ background: rail }}
      />

      <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        {lane && (
          <span className="text-[13px] font-semibold text-[var(--text-primary)]">
            {lane.projectName}
          </span>
        )}
        <StateBadge status={status} />
        {/* The product rule: a waiting state says what it waits on. */}
        {'waitingOn' in status && status.waitingOn && (
          <span className="truncate text-[11px] text-[var(--text-secondary)]">
            {waitingText(status.waitingOn, t)}
          </span>
        )}
        <span className="tabular text-[11px] text-[var(--text-muted)]">{when}</span>
      </span>

      <span
        className={`${followedBy ? 'row-span-3' : 'row-span-2'} flex flex-col items-end justify-between gap-1 text-right`}
        title={includes}
      >
        <span className="tabular text-[13px] font-medium text-[var(--text-primary)]">
          {latest.costUsd !== undefined
            ? t('latest.soFar', { cost: formatCost(latest.costUsd) })
            : `${formatTokens(latest.tokens)} ${t('card.tokens')}`}
        </span>
        {latest.costUsd !== undefined && (
          <span className="tabular text-[11px] text-[var(--text-muted)]">
            {formatTokens(latest.tokens)} {t('card.tokens')}
          </span>
        )}
        <span className="text-[var(--text-muted)] transition-colors duration-200 group-hover:text-[var(--accent)]">
          <Icon name="open" size={12} />
        </span>
      </span>

      <span className="mt-1 flex min-w-0 gap-1.5">
        <span className="mt-[3px] shrink-0 text-[var(--text-muted)]" aria-hidden="true">
          <Icon name="prompt" size={12} />
        </span>
        <span className="line-clamp-2 text-[15px] leading-snug text-[var(--text-primary)]">
          {turn.prompt}
        </span>
      </span>

      {followedBy && (
        // Starts under the headline's text, not under its chevron.
        <span className="mt-0.5 truncate pl-[18px] text-[11px] text-[var(--text-muted)]">
          {followedBy}
        </span>
      )}
    </button>
  );
};
