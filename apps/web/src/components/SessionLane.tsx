import type { BoardState, SessionLane as Lane } from '@mirante/shared';
import { formatCost, formatTokens } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { agentOrdinals, describeAgent, type AgentDefinition } from '../lib/agents';
import { agentColor } from '../lib/palette';
import { Icon } from './Icon';
import { AgentCardView } from './AgentCard';

export type SessionLaneProps = {
  lane: Lane;
  approvals: BoardState['pendingApprovals'];
  onDecide: (requestId: string, behavior: 'allow' | 'deny') => void;
  definitions: Map<string, AgentDefinition>;
  onOpen: () => void;
  /**
   * Drawn inside a project section, which already names the project. The lane
   * then leads with what tells its sessions apart — the branch — instead of
   * repeating the heading above it at a larger size.
   */
  inProject?: boolean;
  now?: number | undefined;
};

export const SessionLaneView = ({
  lane,
  approvals,
  onDecide,
  definitions,
  onOpen,
  inProject = false,
  now,
}: SessionLaneProps) => {
  const { t } = useI18n();
  const entrypoint = t(`entry.${lane.entrypoint}` as 'entry.cli');
  const approvalFor = (agentId: string) =>
    approvals.find((a) => a.sessionId === lane.sessionId && a.agentId === agentId);

  const root = lane.cards.find((card) => card.agentId === 'main');
  const subagents = lane.cards.filter((card) => card.agentId !== 'main');
  const identify = (card: (typeof lane.cards)[number]) => describeAgent(card, t);
  const ordinals = agentOrdinals(lane.cards, (card) => identify(card).name);

  return (
    <section
      className="rounded-xl border p-3"
      style={{ background: 'var(--surface-2)', borderColor: 'var(--hairline)' }}
    >
      <header className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={onOpen}
          className="flex cursor-pointer items-center gap-1.5 text-[13px] font-semibold text-[var(--text-primary)] transition-colors hover:text-[var(--accent)]"
        >
          {inProject && lane.gitBranch ? (
            <>
              <Icon name="branch" size={12} />
              {lane.gitBranch}
            </>
          ) : (
            lane.projectName
          )}
          <Icon name="open" size={11} />
        </button>
        {!inProject && lane.gitBranch && (
          <span className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)]">
            <Icon name="branch" size={11} />
            {lane.gitBranch}
          </span>
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
          <span className="tabular">
            {formatTokens(lane.tokens)} {t('card.tokens')}
          </span>
          <span className="tabular">{formatCost(lane.costUsd)}</span>
          {lane.context && (
            <span className="tabular">
              {lane.context.usedPercentage.toFixed(0)}% {t('lane.context')}
            </span>
          )}
          {lane.endedAt && <span>{t('lane.ended')}</span>}
        </span>
      </header>

      {root && (
        <AgentCardView
          card={root}
          color="var(--accent)"
          approval={approvalFor(root.agentId)}
          onDecide={onDecide}
          onOpen={onOpen}
          now={now}
          sessionEnded={Boolean(lane.endedAt)}
        />
      )}

      {/*
        Subagents are drawn under the session that spawned them, behind a rule,
        so the tree is visible without a diagram. Colour is assigned in spawn
        order rather than hashed — see lib/palette.
      */}
      {subagents.length > 0 && (
        <div className="mt-2 border-l pl-3" style={{ borderColor: 'var(--baseline)' }}>
          <div className="mb-1.5 text-[10px] text-[var(--text-muted)]">
            {subagents.length === 1
              ? t('card.subagent.one')
              : t('card.subagents', { count: subagents.length })}
          </div>
          <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
            {subagents.map((card, index) => (
              <AgentCardView
                key={card.agentId}
                card={card}
                color={agentColor(index)}
                ordinal={ordinals.get(card.agentId)}
                definition={card.agentType ? definitions.get(card.agentType) : undefined}
                approval={approvalFor(card.agentId)}
                onDecide={onDecide}
                onOpen={onOpen}
                now={now}
                sessionEnded={Boolean(lane.endedAt)}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
};
