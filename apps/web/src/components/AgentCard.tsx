import type { AgentCard as Card, PendingApproval } from '@mirante/shared';
import { isWaitingState } from '@mirante/shared';
import { formatDuration, formatTokens, formatWaitingFor } from '../lib/format';
import { agentIcon, agentLabel } from '../lib/icons';
import { StateBadge } from './StateBadge';

export type AgentCardProps = {
  card: Card;
  /** Identity colour, assigned by the lane in spawn order. */
  color: string;
  approval?: PendingApproval | undefined;
  onDecide: (requestId: string, behavior: 'allow' | 'deny') => void;
  iconOverrides?: Record<string, string>;
};

export const AgentCardView = ({
  card,
  color,
  approval,
  onDecide,
  iconOverrides,
}: AgentCardProps) => {
  const waiting = isWaitingState(card.status.state);
  const isRoot = card.agentId === 'main';
  const running = card.status.state === 'tool_running';

  return (
    <article
      className="rounded-lg border p-3"
      style={{
        background: 'var(--surface-1)',
        borderColor: waiting
          ? 'color-mix(in oklab, var(--status-warning) 40%, var(--hairline))'
          : 'var(--hairline)',
      }}
    >
      <header className="flex items-start gap-2.5">
        {/* The agent's identity, at a size you can find by glancing. */}
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-full text-[15px]"
          style={{ background: `color-mix(in oklab, ${color} 20%, transparent)`, color }}
        >
          {agentIcon(card.agentType, card.agentId, iconOverrides)}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
              {agentLabel(card.agentType, card.agentId)}
            </span>
            {!isRoot && (
              <span className="shrink-0 text-[10px] text-[var(--text-muted)]">subagent</span>
            )}
          </div>
          <div className="truncate text-[10px] text-[var(--text-muted)]">
            {card.model ?? (isRoot ? 'main session' : card.agentId.slice(0, 10))}
          </div>
        </div>

        <StateBadge status={card.status} />
      </header>

      {/*
        The waiting reason is the product: it is rendered before anything else a
        card could say, and it is never collapsed away.
      */}
      {card.status.waitingOn ? (
        <div
          className="mt-2 rounded border-l-2 py-1 pl-2 text-[12px]"
          style={{ borderColor: 'var(--status-warning)', background: 'var(--surface-2)' }}
        >
          <div className="text-[var(--text-primary)]">{card.status.waitingOn.summary}</div>
          <div className="mt-0.5 text-[10px] text-[var(--text-muted)]">
            waiting {formatWaitingFor(card.status.waitingOn.since)}
          </div>
        </div>
      ) : (
        <ActivityLine card={card} running={running} color={color} />
      )}

      {approval && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onDecide(approval.requestId, 'allow')}
            className="rounded px-2.5 py-1 text-[11px] font-medium text-white"
            style={{ background: 'var(--status-good)' }}
          >
            Allow
          </button>
          <button
            type="button"
            onClick={() => onDecide(approval.requestId, 'deny')}
            className="rounded px-2.5 py-1 text-[11px] font-medium text-white"
            style={{ background: 'var(--status-critical)' }}
          >
            Deny
          </button>
          <span className="text-[10px] text-[var(--text-muted)]">or the terminal will ask</span>
        </div>
      )}

      <footer className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
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
        {card.runningChildren > 0 && (
          <span className="ml-auto text-[10px]" style={{ color: 'var(--accent)' }}>
            ⇣ {card.runningChildren} agent{card.runningChildren === 1 ? '' : 's'} running
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
  const current = card.activity;
  const previous = card.lastActivity;

  if (!current && !previous) return null;

  return (
    <div className="mt-2 flex items-start gap-1.5 text-[12px]">
      <span
        aria-hidden="true"
        className="mt-[3px] shrink-0 text-[9px]"
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
        {!current && <div className="text-[10px] text-[var(--text-muted)]">last action</div>}
      </div>
    </div>
  );
};
