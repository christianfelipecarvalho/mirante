import { useState, type CSSProperties } from 'react';
import type { BoardState, Entrypoint, Harness, SessionLane as Lane } from '@mirante/shared';
import { formatCost, formatDuration, formatTokens } from '../lib/format';
import { useI18n, type Translate } from '../lib/i18n';
import { agentOrdinals, describeAgent, type AgentDefinition } from '../lib/agents';
import { agentColor } from '../lib/palette';
import { livenessOf } from '../lib/liveness';
import { groupAgents, type AgentGroups } from '../lib/buckets';
import { modelLabel } from '../lib/models';
import { Icon } from './Icon';
import { AgentCardView } from './AgentCard';
import { AgentFlow } from './AgentFlow';

/**
 * Launch labels that differ by harness. "claude -p" and "codex exec" are the
 * same kind of launch, named by each tool its own way; the rest read the same.
 */
const ENTRY_LABEL: Partial<Record<`${Harness}:${Entrypoint}`, 'entry.codex.print'>> = {
  'codex:print': 'entry.codex.print',
};

/** How a session was launched, in the words of the harness that launched it. */
export const entryLabel = (lane: Pick<Lane, 'harness' | 'entrypoint'>, t: Translate): string =>
  t(
    ENTRY_LABEL[`${lane.harness}:${lane.entrypoint}`] ??
      (`entry.${lane.entrypoint}` as 'entry.cli'),
  );

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
  const entrypoint = entryLabel(lane, t);
  const approvalFor = (agentId: string) =>
    approvals.find((a) => a.sessionId === lane.sessionId && a.agentId === agentId);

  const root = lane.cards.find((card) => card.agentId === 'main');
  const subagents = lane.cards.filter((card) => card.agentId !== 'main');
  const identify = (card: (typeof lane.cards)[number]) => describeAgent(card, t);
  const ordinals = agentOrdinals(lane.cards, (card) => identify(card).name);
  // Colour is assigned once, in spawn order, and then follows the agent: the
  // lane reorders by state, and a card that changed colour because it moved
  // would be a different agent as far as the reader is concerned.
  const colorOf = new Map(subagents.map((card, index) => [card.agentId, agentColor(index)]));
  // The lane glows when anything inside it is really working; which agent, and
  // how far along, is the card's business. See the card section in index.css.
  const ended = Boolean(lane.endedAt);
  const live = lane.cards.some((card) => livenessOf(card, now ?? Date.now(), ended) === 'live');
  // What still needs a card, and what has become a line in a ledger.
  const groups = groupAgents(subagents, now ?? Date.now(), ended);
  const openView = (tab: 'flow' | 'activity', agentId?: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    if (agentId) url.searchParams.set('agent', agentId);
    else url.searchParams.delete('agent');
    window.history.replaceState({}, '', url);
    onOpen();
  };

  return (
    <section
      // Inside a project card the lane is a section of that card, not a box of
      // its own: three nested boxes made project, session and agent the same
      // weight. On its own it keeps its frame.
      className={inProject ? 'min-w-0 py-3' : 'glow-card glow-quiet min-w-0 rounded-xl border p-3'}
      {...(inProject ? {} : { 'data-life': live ? 'working' : 'still' })}
      style={
        inProject
          ? undefined
          : ({
              '--card-surface': 'var(--surface-2)',
              '--glow': 'var(--accent)',
            } as CSSProperties)
      }
    >
      <header className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={onOpen}
          className={`flex cursor-pointer items-center gap-1.5 transition-colors hover:text-[var(--accent)] ${
            inProject
              ? 'text-[12px] font-medium text-[var(--text-secondary)]'
              : 'text-[13px] font-semibold text-[var(--text-primary)]'
          }`}
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
        {/* Which coding agent runs this session, in its own words: the glyph is
            the same for every harness, so the name is what tells them apart. */}
        <span
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
          style={{ background: 'var(--surface-1)', color: 'var(--text-secondary)' }}
        >
          <Icon name="harness" size={11} />
          {t(`harness.${lane.harness}`)}
        </span>
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
          sessionEnded={ended}
        />
      )}

      {/* The hierarchy belongs on the board itself, where the team is observed.
          Full cards below retain the details and approval controls. */}
      {subagents.length > 0 && (
        <div className="mt-3 min-w-0">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[10px] text-[var(--text-secondary)]">
            <span>
              <span className="mr-2 font-medium">{t('detail.tab.flow')}</span>
              {subagents.length === 1
                ? t('card.subagent.one')
                : t('card.subagents', { count: subagents.length })}
            </span>
            <button
              type="button"
              onClick={() => openView('flow')}
              className="pressable flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--accent)]"
            >
              <Icon name="handoff" size={11} />
              {t('flow.open')}
            </button>
          </div>
          <AgentFlow
            lane={lane}
            now={now ?? Date.now()}
            compact
            onOpen={(id) => openView('activity', id)}
          />
          <div className="mt-2 grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
            {groups.open.map((card) => (
              <AgentCardView
                key={card.agentId}
                card={card}
                color={colorOf.get(card.agentId) ?? 'var(--agent-neutral)'}
                ordinal={ordinals.get(card.agentId)}
                definition={card.agentType ? definitions.get(card.agentType) : undefined}
                approval={approvalFor(card.agentId)}
                onDecide={onDecide}
                onOpen={onOpen}
                now={now}
                sessionEnded={ended}
              />
            ))}
          </div>
          {groups.closed.map((group) => (
            <ClosedAgents
              key={group.bucket}
              group={group}
              colorOf={colorOf}
              identify={(card) => identify(card).name}
              ordinals={ordinals}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </section>
  );
};

/**
 * What is over, as one line instead of a wall of cards.
 *
 * A finished agent is not a window any more, and a card for it competes for
 * attention with the two that are working. The group says how many and lets the
 * person open it; each row still says what that agent was asked to do, because
 * a list of names answers nothing.
 *
 * "No signal" leads with why, in visible text rather than a tooltip: it is the
 * one group that reports a gap in Mirante itself, and hiding the reason behind
 * a hover would hide a defect.
 */
const ClosedAgents = ({
  group,
  colorOf,
  identify,
  ordinals,
  onOpen,
}: {
  group: AgentGroups['closed'][number];
  colorOf: Map<string, string>;
  identify: (card: Lane['cards'][number]) => string;
  ordinals: Map<string, number>;
  onOpen: () => void;
}) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const id = `closed-${group.bucket}`;
  const silent = group.bucket === 'no_signal';
  const count = group.cards.length;
  const label = silent
    ? count === 1
      ? t('group.noSignalOne')
      : t('group.noSignal', { n: count })
    : count === 1
      ? t('group.finishedOne')
      : t('group.finished', { n: count });

  return (
    <div className="mt-2 rounded-md px-2 py-1.5" style={{ background: 'var(--surface-1)' }}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((was) => !was)}
          className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)] transition-colors duration-200 hover:text-[var(--text-primary)]"
        >
          <span
            aria-hidden="true"
            className="transition-transform duration-150"
            style={{ transform: open ? 'none' : 'rotate(-90deg)' }}
          >
            <Icon name="disclose" size={12} />
          </span>
          <Icon name={silent ? 'unknown' : 'check'} size={12} />
          {label}
        </button>
        <span className="text-[11px] text-[var(--text-muted)]">
          {open ? t('group.putAway') : t('group.show')}
        </span>
      </div>

      {silent && (
        <p className="mt-1 max-w-[68ch] text-[11px] text-[var(--text-secondary)]">
          {t('group.noSignalWhy')}
        </p>
      )}

      {open && (
        <ul id={id} className="mt-1.5 flex flex-col gap-1">
          {group.cards.map((card) => (
            <li key={card.agentId}>
              <button
                type="button"
                onClick={onOpen}
                className="flex w-full cursor-pointer items-baseline gap-2 rounded px-1 py-1 text-left text-[11px] transition-colors duration-200 hover:bg-[var(--surface-2)]"
              >
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 self-center rounded-full"
                  style={{ background: colorOf.get(card.agentId) ?? 'var(--agent-neutral)' }}
                />
                <span className="shrink-0 font-medium text-[var(--text-primary)]">
                  {identify(card)}
                  {ordinals.get(card.agentId) !== undefined && ` ${ordinals.get(card.agentId)}`}
                </span>
                <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">
                  {card.task ?? card.lastActivity ?? ''}
                </span>
                {/* Left out when unknown: a row has no model column to leave blank. */}
                {modelLabel(card.model) && (
                  <span
                    className="shrink-0 text-[10px] font-medium text-[var(--text-primary)]"
                    title={modelLabel(card.model)?.full}
                  >
                    {modelLabel(card.model)?.short}
                  </span>
                )}
                <span className="tabular shrink-0 text-[10px] text-[var(--text-secondary)]">
                  {silent
                    ? t('card.lastSignalAgo', {
                        d: formatDuration(card.lastEventAt ?? card.startedAt),
                      })
                    : t('card.took', { d: formatDuration(card.startedAt, card.endedAt) })}
                </span>
                <span className="tabular shrink-0 text-[10px] text-[var(--text-secondary)]">
                  {formatTokens(card.tokens)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
