import { useEffect, useMemo, useState } from 'react';
import type { BoardState, MiranteEvent, SessionLane } from '@mirante/shared';
import { totalTokens } from '@mirante/shared';
import { formatCost, formatDuration, formatTokens, formatWhen } from '../lib/format';
import { agentIcon, agentLabel } from '../lib/icons';
import { useI18n } from '../lib/i18n';
import { agentColor } from '../lib/palette';
import { buildSteps } from '../lib/steps';
import { buildTurns, type Turn } from '../lib/turns';
import { ActivityStream } from './ActivityStream';
import { AgentCardView } from './AgentCard';
import { StateBadge } from './StateBadge';

type Tab = 'agents' | 'activity' | 'requests';

export type SessionDetailProps = {
  lane: SessionLane;
  events: MiranteEvent[];
  approvals: BoardState['pendingApprovals'];
  onDecide: (requestId: string, behavior: 'allow' | 'deny') => void;
  onClose: () => void;
};

export const SessionDetail = ({
  lane,
  events,
  approvals,
  onDecide,
  onClose,
}: SessionDetailProps) => {
  const { t } = useI18n();
  // Tab and agent live in the URL alongside the session, so a particular agent's
  // activity can be linked to directly and survives a reload.
  const params = new URLSearchParams(window.location.search);
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab | null) ?? 'agents');
  const [agentId, setAgentId] = useState<string | undefined>(params.get('agent') ?? undefined);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    if (agentId) url.searchParams.set('agent', agentId);
    else url.searchParams.delete('agent');
    window.history.replaceState({}, '', url);
  }, [tab, agentId]);

  const steps = useMemo(
    () => buildSteps(events, { sessionId: lane.sessionId, agentId }),
    [events, lane.sessionId, agentId],
  );
  const turns = useMemo(() => buildTurns(events, lane.sessionId), [events, lane.sessionId]);

  const colorFor = (index: number, isRoot: boolean) =>
    isRoot ? 'var(--accent)' : agentColor(index);
  const subagents = lane.cards.filter((card) => card.agentId !== 'main');
  const root = lane.cards.find((card) => card.agentId === 'main');

  const openAgent = (id: string) => {
    setAgentId(id);
    setTab('activity');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <header
        className="rounded-xl border px-4 py-3"
        style={{ background: 'var(--surface-2)', borderColor: 'var(--hairline)' }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            style={{ borderColor: 'var(--hairline)' }}
          >
            ← {t('detail.back')}
          </button>
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
            {lane.projectName}
          </h2>
          {lane.gitBranch && (
            <span className="text-[11px] text-[var(--text-secondary)]">⑂ {lane.gitBranch}</span>
          )}
          <span
            className="rounded px-1.5 py-0.5 text-[10px]"
            style={{ background: 'var(--surface-1)', color: 'var(--text-muted)' }}
          >
            {t(`entry.${lane.entrypoint}` as 'entry.cli')}
          </span>
          <span className="ml-auto flex items-center gap-4 text-[11px] text-[var(--text-muted)]">
            <span className="tabular">
              {formatTokens(lane.tokens)} {t('card.tokens')}
            </span>
            <span className="tabular">{formatCost(lane.costUsd)}</span>
            {lane.context && (
              <span className="tabular">
                {lane.context.usedPercentage.toFixed(0)}% {t('lane.context')}
              </span>
            )}
          </span>
        </div>

        <nav className="mt-3 flex gap-1">
          {(['agents', 'activity', 'requests'] as Tab[]).map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setTab(name)}
              className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
              style={{
                background: tab === name ? 'var(--surface-1)' : 'transparent',
                color: tab === name ? 'var(--text-primary)' : 'var(--text-secondary)',
              }}
            >
              {t(`detail.tab.${name}` as 'detail.tab.agents')}
              {name === 'agents' && ` (${lane.cards.length})`}
              {name === 'requests' && ` (${turns.length})`}
            </button>
          ))}
        </nav>
      </header>

      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border"
        style={{ background: 'var(--surface-2)', borderColor: 'var(--hairline)' }}
      >
        {tab === 'agents' && (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {root && (
              <AgentCardView
                card={root}
                color="var(--accent)"
                approval={approvals.find(
                  (a) => a.sessionId === lane.sessionId && a.agentId === root.agentId,
                )}
                onDecide={onDecide}
                onOpen={() => openAgent(root.agentId)}
              />
            )}
            {subagents.length === 0 ? (
              <p className="px-1 py-6 text-center text-[12px] text-[var(--text-muted)]">
                {t('detail.agents.empty')}
              </p>
            ) : (
              <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
                {subagents.map((card, index) => (
                  <AgentCardView
                    key={card.agentId}
                    card={card}
                    color={colorFor(index, false)}
                    approval={approvals.find(
                      (a) => a.sessionId === lane.sessionId && a.agentId === card.agentId,
                    )}
                    onDecide={onDecide}
                    onOpen={() => openAgent(card.agentId)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'activity' && (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Agent picker stays put; only the stream under it scrolls. */}
            <div
              className="flex shrink-0 flex-wrap gap-1.5 border-b px-3 py-2"
              style={{ borderColor: 'var(--hairline)' }}
            >
              <AgentChip
                label={t('detail.allAgents')}
                glyph="◎"
                color="var(--text-secondary)"
                active={agentId === undefined}
                onClick={() => setAgentId(undefined)}
              />
              {lane.cards.map((card, index) => (
                <AgentChip
                  key={card.agentId}
                  label={
                    card.agentId === 'main'
                      ? t('card.session')
                      : agentLabel(card.agentType, card.agentId)
                  }
                  glyph={agentIcon(card.agentType, card.agentId)}
                  color={colorFor(index - 1, card.agentId === 'main')}
                  active={agentId === card.agentId}
                  onClick={() => setAgentId(card.agentId)}
                />
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ActivityStream
                steps={steps}
                showAgent={agentId === undefined}
                colorOf={(id) => {
                  const index = lane.cards.findIndex((card) => card.agentId === id);
                  return colorFor(index - 1, id === 'main');
                }}
              />
            </div>
          </div>
        )}

        {tab === 'requests' && (
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {turns.length === 0 ? (
              <p className="px-1 py-6 text-center text-[12px] text-[var(--text-muted)]">
                {t('detail.requests.empty')}
              </p>
            ) : (
              turns.map((turn) => <TurnRow key={turn.promptId} turn={turn} />)
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const AgentChip = ({
  label,
  glyph,
  color,
  active,
  onClick,
}: {
  label: string;
  glyph: string;
  color: string;
  active: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className="flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] transition-colors"
    style={{
      borderColor: active ? color : 'var(--hairline)',
      background: active ? `color-mix(in oklab, ${color} 14%, transparent)` : 'transparent',
      color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
    }}
  >
    <span aria-hidden="true" style={{ color }}>
      {glyph}
    </span>
    {label}
  </button>
);

/** One request, with what it cost and what it set in motion. */
const TurnRow = ({ turn }: { turn: Turn }) => {
  const { t } = useI18n();
  const plan = turn.planUsage?.fiveHour?.usedPercentage;

  return (
    <article
      className="rounded-lg border p-3"
      style={{ background: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
    >
      <header className="flex items-start gap-2">
        <span aria-hidden="true" className="mt-[2px] text-[13px] text-[var(--text-muted)]">
          ›
        </span>
        <p className="min-w-0 flex-1 text-[13px] text-[var(--text-primary)]">
          {turn.prompt || t('detail.request')}
        </p>
        {turn.open && <StateBadge status={{ state: 'thinking' }} />}
      </header>

      <dl className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1.5 text-[11px]">
        <Metric label={t('detail.requestAt', { time: formatWhen(turn.startedAt) })} value="" />
        <Metric
          label={t('detail.agentsSpawned')}
          value={String(turn.agentsSpawned)}
          hint={turn.agentTypes.slice(0, 3).join(', ')}
        />
        <Metric
          label={t('detail.toolsRun')}
          value={String(turn.toolsRun)}
          {...(turn.toolsFailed > 0
            ? { hint: t('detail.toolsFailed', { count: turn.toolsFailed }), danger: true }
            : {})}
        />
        <Metric label={t('stat.tokens')} value={formatTokens(turn.tokens)} />
        <Metric
          label={t('detail.duration')}
          value={
            turn.open ? t('detail.stillRunning') : formatDuration(turn.startedAt, turn.endedAt)
          }
        />
        <Metric
          label={t('detail.planAtTime')}
          value={plan === undefined ? t('detail.planUnknown') : `${plan.toFixed(0)}%`}
        />
      </dl>
    </article>
  );
};

const Metric = ({
  label,
  value,
  hint,
  danger,
}: {
  label: string;
  value: string;
  hint?: string;
  danger?: boolean;
}) => (
  <div>
    <dt className="text-[10px] text-[var(--text-muted)]">{label}</dt>
    <dd
      className="tabular text-[12px] font-medium"
      style={{ color: danger ? 'var(--status-critical)' : 'var(--text-primary)' }}
    >
      {value}
      {hint && (
        <span className="ml-1.5 text-[10px] font-normal text-[var(--text-muted)]">{hint}</span>
      )}
    </dd>
  </div>
);

export const totalTokensOf = totalTokens;
