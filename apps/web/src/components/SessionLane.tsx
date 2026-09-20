import type { BoardState, SessionLane as Lane } from '@mirante/shared';
import { formatCost, formatTokens } from '../lib/format';
import { agentColor } from '../lib/palette';
import { AgentCardView } from './AgentCard';

const ENTRYPOINT_LABEL: Record<string, string> = {
  cli: 'terminal',
  vscode: 'VS Code',
  sdk: 'SDK',
  print: 'claude -p',
  unknown: '',
};

export type SessionLaneProps = {
  lane: Lane;
  approvals: BoardState['pendingApprovals'];
  onDecide: (requestId: string, behavior: 'allow' | 'deny') => void;
};

export const SessionLaneView = ({ lane, approvals, onDecide }: SessionLaneProps) => {
  const entrypoint = ENTRYPOINT_LABEL[lane.entrypoint] ?? '';
  const approvalFor = (agentId: string) =>
    approvals.find((a) => a.sessionId === lane.sessionId && a.agentId === agentId);

  const root = lane.cards.find((card) => card.agentId === 'main');
  const subagents = lane.cards.filter((card) => card.agentId !== 'main');

  return (
    <section
      className="rounded-xl border p-3"
      style={{ background: 'var(--surface-2)', borderColor: 'var(--hairline)' }}
    >
      <header className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">{lane.projectName}</h3>
        {lane.gitBranch && (
          <span className="text-[11px] text-[var(--text-secondary)]">⑂ {lane.gitBranch}</span>
        )}
        {entrypoint && (
          <span
            className="rounded px-1.5 py-0.5 text-[10px]"
            style={{ background: 'var(--surface-1)', color: 'var(--text-muted)' }}
          >
            {entrypoint}
          </span>
        )}
        <span className="ml-auto flex items-center gap-3 text-[11px] text-[var(--text-muted)]">
          <span className="tabular">{formatTokens(lane.tokens)} tok</span>
          <span className="tabular">{formatCost(lane.costUsd)}</span>
          {lane.context && (
            <span className="tabular">{lane.context.usedPercentage.toFixed(0)}% ctx</span>
          )}
          {lane.endedAt && <span>ended</span>}
        </span>
      </header>

      {root && (
        <AgentCardView
          card={root}
          color="var(--accent)"
          approval={approvalFor(root.agentId)}
          onDecide={onDecide}
        />
      )}

      {/*
        Subagents are drawn under the session that spawned them, behind a rule,
        so the tree is visible without a diagram. Colour is assigned in spawn
        order rather than hashed — see lib/palette.
      */}
      {subagents.length > 0 && (
        <div className="mt-2 border-l pl-3" style={{ borderColor: 'var(--baseline)' }}>
          <div className="mb-1.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
            {subagents.length} subagent{subagents.length === 1 ? '' : 's'}
          </div>
          <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
            {subagents.map((card, index) => (
              <AgentCardView
                key={card.agentId}
                card={card}
                color={agentColor(index)}
                approval={approvalFor(card.agentId)}
                onDecide={onDecide}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
};
