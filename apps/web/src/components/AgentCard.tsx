import type { AgentCard as Card, PendingApproval } from '@mirante/shared';
import { isWaitingState } from '@mirante/shared';
import { formatDuration, formatTokens, formatWaitingFor } from '../lib/format';
import { agentIcon, agentLabel } from '../lib/icons';
import { StateBadge } from './StateBadge';

export type AgentCardProps = {
  card: Card;
  approval?: PendingApproval | undefined;
  onDecide: (requestId: string, behavior: 'allow' | 'deny') => void;
  iconOverrides?: Record<string, string>;
};

export const AgentCardView = ({ card, approval, onDecide, iconOverrides }: AgentCardProps) => {
  const waiting = isWaitingState(card.status.state);
  const isRoot = card.agentId === 'main';

  return (
    <article
      className="rounded-lg border p-3 transition-colors"
      style={{
        background: 'var(--surface-1)',
        // A blocked card gets a border in its own status colour. The badge below
        // still names the state, so this is emphasis, not the signal itself.
        borderColor: waiting
          ? 'color-mix(in oklab, currentColor 35%, var(--hairline))'
          : 'var(--hairline)',
        color: waiting ? 'var(--status-warning)' : 'inherit',
      }}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="text-[15px] leading-none">
            {agentIcon(card.agentType, card.agentId, iconOverrides)}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-[var(--text-primary)]">
              {agentLabel(card.agentType, card.agentId)}
            </div>
            {card.model && (
              <div className="truncate text-[10px] text-[var(--text-muted)]">{card.model}</div>
            )}
          </div>
        </div>
        <StateBadge status={card.status} />
      </header>

      {/*
        The waiting reason is the product. A card that only says "waiting"
        answers nothing, so the reason is rendered before activity and never
        collapsed away.
      */}
      {card.status.waitingOn ? (
        <div
          className="mt-2 rounded border-l-2 py-1 pl-2 text-[12px]"
          style={{ borderColor: 'currentColor', background: 'var(--surface-2)' }}
        >
          <div className="text-[var(--text-primary)]">{card.status.waitingOn.summary}</div>
          <div className="mt-0.5 text-[10px] text-[var(--text-muted)]">
            waiting {formatWaitingFor(card.status.waitingOn.since)}
          </div>
        </div>
      ) : (
        card.activity && (
          <div
            className="mt-2 truncate text-[12px] text-[var(--text-secondary)]"
            title={card.activity}
          >
            {card.activity}
          </div>
        )
      )}

      {approval && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => onDecide(approval.requestId, 'allow')}
            className="rounded px-2 py-1 text-[11px] font-medium text-white"
            style={{ background: 'var(--status-good)' }}
          >
            Allow
          </button>
          <button
            type="button"
            onClick={() => onDecide(approval.requestId, 'deny')}
            className="rounded px-2 py-1 text-[11px] font-medium text-white"
            style={{ background: 'var(--status-critical)' }}
          >
            Deny
          </button>
          <span className="text-[10px] text-[var(--text-muted)]">or the terminal will ask</span>
        </div>
      )}

      <footer className="mt-2 flex items-center gap-3 text-[11px] text-[var(--text-muted)]">
        <span className="tabular">{formatTokens(card.tokens)} tok</span>
        <span className="tabular">{formatDuration(card.startedAt, card.endedAt)}</span>
        {card.activeSkill && (
          <span
            className="rounded px-1.5 py-0.5 text-[10px]"
            style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
          >
            skill: {card.activeSkill}
          </span>
        )}
        {/*
          Async children do not block the parent, so they are a count rather than
          a waiting state. Showing them as "blocked" would misreport the session.
        */}
        {isRoot && card.runningChildren > 0 && (
          <span className="ml-auto text-[10px]" style={{ color: 'var(--accent)' }}>
            {card.runningChildren} agent{card.runningChildren === 1 ? '' : 's'} running
          </span>
        )}
      </footer>
    </article>
  );
};
