import type { AgentCard as Card, PendingApproval, WaitingOn } from '@mirante/shared';
import { isWaitingState } from '@mirante/shared';
import { formatDuration, formatTokens, formatWaitingFor } from '../lib/format';
import { agentRoleKey } from '../lib/agents';
import { agentIcon, agentLabel } from '../lib/icons';
import { useI18n, type Translate } from '../lib/i18n';
import { StateBadge } from './StateBadge';

/**
 * The waiting reason, in the reader's language.
 *
 * The daemon writes an English `summary` and, where it can, the reason as a
 * value plus its subject. Prefer the value — a sentence written by the server
 * cannot be translated — and fall back to the summary so a reason Mirante does
 * not yet model still reaches the screen.
 */
const waitingText = (waitingOn: WaitingOn, t: Translate): string => {
  switch (waitingOn.reason) {
    case 'subagent':
      return t('waiting.subagent', { subject: waitingOn.subject ?? '' });
    case 'approval':
      return waitingOn.detail
        ? `${t('waiting.approval', { subject: waitingOn.subject ?? '' })}: ${waitingOn.detail}`
        : t('waiting.approval', { subject: waitingOn.subject ?? '' });
    case 'input':
      return t('waiting.input');
    case 'plan_limit':
      return t('waiting.plan_limit', { subject: waitingOn.subject ?? '' });
    default:
      return waitingOn.summary;
  }
};

export type AgentCardProps = {
  card: Card;
  color: string;
  /** Position among agents sharing a type, when there is more than one. */
  ordinal?: number | undefined;
  approval?: PendingApproval | undefined;
  onDecide: (requestId: string, behavior: 'allow' | 'deny') => void;
  onOpen?: (() => void) | undefined;
  iconOverrides?: Record<string, string>;
};

export const AgentCardView = ({
  card,
  color,
  ordinal,
  approval,
  onDecide,
  onOpen,
  iconOverrides,
}: AgentCardProps) => {
  const { t } = useI18n();
  const waiting = isWaitingState(card.status.state);
  const isRoot = card.agentId === 'main';
  const running = card.status.state === 'tool_running';

  return (
    <article
      className={`rounded-lg border p-3 transition-colors ${onOpen ? 'cursor-pointer hover:border-[var(--accent)]' : ''}`}
      style={{
        background: 'var(--surface-1)',
        borderColor: waiting
          ? 'color-mix(in oklab, var(--status-warning) 40%, var(--hairline))'
          : 'var(--hairline)',
      }}
      onClick={onOpen}
    >
      <header className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-full text-[15px]"
          style={{ background: `color-mix(in oklab, ${color} 20%, transparent)`, color }}
        >
          {agentIcon(card.agentType, card.agentId, iconOverrides)}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
              {isRoot ? t('card.session') : agentLabel(card.agentType, card.agentId)}
            </span>
            {/* Agents sharing a type are otherwise impossible to tell apart. */}
            {ordinal !== undefined && (
              <span
                className="tabular shrink-0 rounded px-1 text-[10px] font-medium"
                style={{ background: `color-mix(in oklab, ${color} 18%, transparent)`, color }}
              >
                #{ordinal}
              </span>
            )}
            {!isRoot && (
              <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
                {t('card.subagent')}
              </span>
            )}
          </div>
          {/* What this agent is for, in words, because its type name rarely says. */}
          <div className="truncate text-[10px] text-[var(--text-muted)]">
            {t(agentRoleKey(card) as 'role.general')}
          </div>
        </div>

        <StateBadge status={card.status} />
      </header>

      {card.status.waitingOn ? (
        <div
          className="mt-2 rounded border-l-2 py-1 pl-2 text-[12px]"
          style={{ borderColor: 'var(--status-warning)', background: 'var(--surface-2)' }}
        >
          <div className="text-[var(--text-primary)]">{waitingText(card.status.waitingOn, t)}</div>
          <div className="mt-0.5 text-[10px] text-[var(--text-muted)]">
            {t('waiting.for', { duration: formatWaitingFor(card.status.waitingOn.since) })}
          </div>
        </div>
      ) : (
        <ActivityLine card={card} running={running} color={color} />
      )}

      {approval && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDecide(approval.requestId, 'allow');
            }}
            className="rounded px-2.5 py-1 text-[11px] font-medium text-white"
            style={{ background: 'var(--status-good)' }}
          >
            {t('card.allow')}
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDecide(approval.requestId, 'deny');
            }}
            className="rounded px-2.5 py-1 text-[11px] font-medium text-white"
            style={{ background: 'var(--status-critical)' }}
          >
            {t('card.deny')}
          </button>
          <span className="text-[10px] text-[var(--text-muted)]">{t('card.orTerminal')}</span>
        </div>
      )}

      <footer className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
        <span className="tabular">
          {formatTokens(card.tokens)} {t('card.tokens')}
        </span>
        <span className="tabular">{formatDuration(card.startedAt, card.endedAt)}</span>
        {card.model && <span className="truncate">{card.model}</span>}
        {card.activeSkill && (
          <span
            className="rounded px-1.5 py-0.5 text-[10px]"
            style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
          >
            {card.activeSkill}
          </span>
        )}
        {card.runningChildren > 0 && (
          <span className="ml-auto text-[10px]" style={{ color: 'var(--accent)' }}>
            ⇣ {t('card.agentsRunning', { count: card.runningChildren })}
          </span>
        )}
      </footer>
    </article>
  );
};

/**
 * What the agent is doing, or failing that, what it did last.
 *
 * A card that shows "Thinking" and nothing else is the most common state a
 * person catches it in, and it answers none of the questions this board exists
 * to answer.
 */
const ActivityLine = ({
  card,
  running,
  color,
}: {
  card: Card;
  running: boolean;
  color: string;
}) => {
  const { t } = useI18n();
  const current = card.activity;
  const previous = card.lastActivity;
  if (!current && !previous) return null;

  return (
    <div className="mt-2 flex items-start gap-1.5 text-[12px]">
      <span
        aria-hidden="true"
        className={`mt-[3px] shrink-0 text-[9px] ${running ? 'animate-pulse' : ''}`}
        style={{ color: running ? color : 'var(--text-muted)' }}
      >
        {running ? '▶' : '↩'}
      </span>
      <div className="min-w-0">
        <div
          className="truncate"
          style={{ color: current ? 'var(--text-secondary)' : 'var(--text-muted)' }}
          title={current ?? previous}
        >
          {current ?? previous}
        </div>
        {!current && (
          <div className="text-[10px] text-[var(--text-muted)]">{t('card.lastAction')}</div>
        )}
      </div>
    </div>
  );
};
