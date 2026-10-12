import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  completionOf,
  isWaitingState,
  livenessOf,
  totalTokens,
  type AgentCard,
  type MiranteEvent,
  type SessionLane,
} from '@mirante/shared';
import { buildAgentMap, filterAgentMap, type AgentMapNode } from '../lib/agent-map';
import { agentMapInstruction } from '../lib/agent-map-instruction';
import { stableAgentCards } from '../lib/agent-flow';
import { agentOrdinals, describeAgent } from '../lib/agents';
import { formatDuration } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { agentIcon } from '../lib/icons';
import { agentColor } from '../lib/palette';
import { useFlowFilter } from '../lib/use-flow-filter';
import { Icon } from './Icon';
import { InstructionText } from './InstructionText';
import { ModelName } from './ModelName';
import { StateBadge, type BadgeOverride } from './StateBadge';
import { AgentProgress } from './AgentProgress';
import './AgentMapDialog.css';

export type AgentMapDialogProps = {
  lane: SessionLane;
  events: readonly MiranteEvent[];
  now: number;
  onClose: () => void;
  onOpenAgent: (id: string) => void;
  initialOrder?: readonly string[];
};

const presentation = (card: AgentCard, now: number, ended: boolean) => {
  const completion = completionOf(card);
  const liveness = livenessOf(card, now, ended);
  const override: BadgeOverride | undefined =
    completion === 'interrupted'
      ? 'interrupted'
      : completion === 'unknown'
        ? 'unconfirmed'
        : !completion && liveness === 'silent'
          ? 'silent'
          : undefined;
  return {
    override,
    life:
      !card.endedAt && liveness === 'live'
        ? 'working'
        : !completion && isWaitingState(card.status.state)
          ? 'waiting'
          : 'rest',
  };
};

/** A focused reading view. The spatial canvas stays mounted behind the dialog,
 * and instruction translation only mounts for the agent being inspected. */
export const AgentMapDialog = ({
  lane,
  events,
  now,
  onClose,
  onOpenAgent,
  initialOrder,
}: AgentMapDialogProps) => {
  const { t, locale } = useI18n();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const lastSelected = useRef<string | undefined>(undefined);
  const backdropDown = useRef(false);
  const { onlyWorking, setOnlyWorking } = useFlowFilter();
  const [selection, setSelection] = useState<AgentCard>();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const remembered = useRef<{ sessionId: string; order: readonly string[] }>({
    sessionId: lane.sessionId,
    order: initialOrder ?? [],
  });
  const ordered = useMemo(
    () =>
      stableAgentCards(
        lane.cards,
        remembered.current.sessionId === lane.sessionId ? remembered.current.order : [],
      ),
    [lane.cards, lane.sessionId],
  );
  useEffect(() => {
    remembered.current = { sessionId: lane.sessionId, order: ordered.order };
  }, [ordered, lane.sessionId]);
  const fullMap = useMemo(() => buildAgentMap(ordered.cards), [ordered.cards]);
  const map = useMemo(
    () => (onlyWorking ? filterAgentMap(fullMap, now, Boolean(lane.endedAt)) : fullMap),
    [onlyWorking, fullMap, now, lane.endedAt],
  );
  const byId = useMemo(
    () => new Map(fullMap.nodes.map((node) => [node.card.agentId, node])),
    [fullMap],
  );
  const ordinals = agentOrdinals(ordered.cards, (card) => describeAgent(card, t).name);
  const colors = new Map(
    ordered.cards
      .filter((card) => card.agentId !== 'main')
      .map((card, index) => [card.agentId, agentColor(index)]),
  );
  const colorOf = (card: AgentCard) => colors.get(card.agentId) ?? 'var(--accent)';
  const nameOf = (card: AgentCard) =>
    `${describeAgent(card, t).name}${ordinals.has(card.agentId) ? ` ${ordinals.get(card.agentId)}` : ''}`;
  const anchor = map.nodes.find((node) => node.card.agentId === 'main') ?? map.nodes[0];
  const rootFor = new Map<string, string>();
  for (const node of fullMap.nodes)
    rootFor.set(
      node.card.agentId,
      node.parentId ? (rootFor.get(node.parentId) ?? node.card.agentId) : node.card.agentId,
    );
  // Nodes are parent-first. Propagate hidden branches once rather than
  // walking every ancestor for every row in a deep or large map.
  const hiddenBranches = new Set<string>();
  const visibleRows = map.nodes.filter((node) => {
    if (node.parentId && (collapsed.has(node.parentId) || hiddenBranches.has(node.parentId))) {
      hiddenBranches.add(node.card.agentId);
      return false;
    }
    return node.card.agentId !== anchor?.card.agentId;
  });
  const branches = visibleRows.filter(
    (node) => rootFor.get(node.card.agentId) === anchor?.card.agentId,
  );
  const detached = visibleRows.filter(
    (node) => rootFor.get(node.card.agentId) !== anchor?.card.agentId,
  );
  const selected = selection ? (byId.get(selection.agentId)?.card ?? selection) : undefined;
  const selectedNode = selected ? byId.get(selected.agentId) : undefined;
  const parent = selectedNode?.parentId ? byId.get(selectedNode.parentId)?.card : undefined;
  const model = selected?.model ?? (selected?.agentId === 'main' ? lane.model : undefined);
  const instruction = selected ? agentMapInstruction(lane, selected, events) : undefined;

  useEffect(() => {
    const element = dialog.current;
    const trigger =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    element?.showModal();
    heading.current?.focus({ preventScroll: true });
    return () => {
      element?.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (selected) detailHeading.current?.focus({ preventScroll: true });
    else if (lastSelected.current)
      (buttons.current.get(lastSelected.current) ?? heading.current)?.focus({
        preventScroll: true,
      });
  }, [selected?.agentId]);

  const open = (card: AgentCard) => {
    lastSelected.current = card.agentId;
    setSelection(card);
  };
  const toggle = (agentId: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  const renderNode = (node: AgentMapNode, root = false) => {
    const card = node.card;
    const { override, life } = presentation(card, now, Boolean(lane.endedAt));
    const name = nameOf(card);
    const childCount = node.childIds.length;
    return (
      <li
        key={card.agentId}
        className={`agent-map-row${root ? ' agent-map-anchor' : ''}`}
        data-nested={!root && node.depth > 1}
        style={
          {
            '--map-depth': Math.min(
              5,
              root
                ? 0
                : Math.max(
                    0,
                    node.depth - (rootFor.get(card.agentId) === anchor?.card.agentId ? 1 : 0),
                  ),
            ),
          } as CSSProperties
        }
      >
        <div className="agent-map-row-controls">
          <button
            type="button"
            className="agent-map-agent pressable"
            data-life={life}
            data-agent-id={card.agentId}
            style={{ '--map-agent-color': colorOf(card) } as CSSProperties}
            onClick={() => open(card)}
            ref={(element) => {
              if (element) buttons.current.set(card.agentId, element);
              else buttons.current.delete(card.agentId);
            }}
          >
            <span className="agent-map-mark" aria-hidden="true">
              <Icon name={agentIcon(card.agentType, card.agentId, {}, card.task)} size={18} />
            </span>
            <span className="agent-map-identity">
              <span className="agent-map-identity-heading">
                <strong>{name}</strong>
                <AgentProgress card={card} now={now} sessionEnded={Boolean(lane.endedAt)} />
              </span>
              <span>
                {card.agentId === 'main'
                  ? t('card.mainSession')
                  : (describeAgent(card, t).typeLabel ?? t('card.subagent'))}
              </span>
              {card.task && (
                <span className="agent-map-task" title={card.task}>
                  {card.task}
                </span>
              )}
            </span>
            <StateBadge status={card.status} override={override} />
            <Icon name="open" size={14} />
          </button>
          {!root && childCount > 0 && (
            <button
              type="button"
              className="agent-map-fold pressable"
              aria-expanded={!collapsed.has(card.agentId)}
              aria-label={t(
                collapsed.has(card.agentId) ? 'map.expandBranch' : 'map.collapseBranch',
                { name },
              )}
              onClick={() => toggle(card.agentId)}
            >
              <Icon name={collapsed.has(card.agentId) ? 'plus' : 'minus'} size={14} />
              <span className="tabular">{childCount}</span>
            </button>
          )}
        </div>
        {!root && node.depth > 1 && node.parentId && (
          <span className="agent-map-parent">
            {t('map.from', { name: nameOf(byId.get(node.parentId)!.card) })}
          </span>
        )}
      </li>
    );
  };
  const outside = (event: { clientX: number; clientY: number }) => {
    const rect = dialog.current?.getBoundingClientRect();
    return (
      rect &&
      (event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom)
    );
  };
  if (typeof document === 'undefined') return null;
  return createPortal(
    <dialog
      ref={dialog}
      className="agent-map-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        backdropDown.current = Boolean(event.target === event.currentTarget && outside(event));
      }}
      onClick={(event) => {
        if (backdropDown.current && event.target === event.currentTarget && outside(event))
          onClose();
        backdropDown.current = false;
      }}
    >
      <header className="agent-map-header">
        <div>
          <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>
            {t('map.title')}
          </h2>
          <p>{lane.projectName}</p>
        </div>
        <button
          type="button"
          className="agent-map-close pressable"
          aria-label={t('map.close')}
          onClick={onClose}
        >
          <Icon name="cross" size={20} />
        </button>
      </header>
      <div hidden={Boolean(selected)} className="agent-map-overview">
        <div className="agent-map-toolbar">
          <div className="agent-map-filter" role="group" aria-label={t('flow.filter')}>
            {[false, true].map((value) => (
              <button
                type="button"
                key={String(value)}
                className="pressable"
                aria-pressed={onlyWorking === value}
                onClick={() => setOnlyWorking(value)}
              >
                {t(value ? 'flow.onlyWorking' : 'flow.allAgents')}
              </button>
            ))}
          </div>
          <span className="tabular" role="status">
            {t('flow.visible', { shown: map.nodes.length, total: fullMap.nodes.length })}
          </span>
        </div>
        {onlyWorking && <p className="agent-map-hint">{t('flow.filterHint')}</p>}
        <div className="agent-map-scroll">
          {!anchor ? (
            <p className="agent-map-empty">{t('map.empty')}</p>
          ) : (
            <>
              <div className="agent-map-layout">
                <ul className="agent-map-root-list">{renderNode(anchor, true)}</ul>
                <div className="agent-map-branches">
                  {branches.length ? (
                    <ul className="agent-map-list">{branches.map((node) => renderNode(node))}</ul>
                  ) : (
                    <p className="agent-map-empty">{t('map.noChildren')}</p>
                  )}
                </div>
              </div>
              {detached.length > 0 && (
                <section className="agent-map-detached">
                  <h3>{t('map.detached')}</h3>
                  <ul className="agent-map-list">{detached.map((node) => renderNode(node))}</ul>
                </section>
              )}
            </>
          )}
        </div>
      </div>
      {selected && (
        <div className="agent-map-detail">
          <button
            type="button"
            className="agent-map-back pressable"
            onClick={() => setSelection(undefined)}
          >
            <Icon name="back" size={16} />
            {t('map.back')}
          </button>
          <div className="agent-map-detail-scroll">
            <div className="agent-map-detail-identity">
              <span style={{ color: colorOf(selected) }} aria-hidden="true">
                <Icon
                  name={agentIcon(selected.agentType, selected.agentId, {}, selected.task)}
                  size={24}
                />
              </span>
              <h3 tabIndex={-1} ref={detailHeading}>
                {nameOf(selected)}
              </h3>
              <AgentProgress card={selected} now={now} sessionEnded={Boolean(lane.endedAt)} />
              <StateBadge
                status={selected.status}
                override={presentation(selected, now, Boolean(lane.endedAt)).override}
              />
            </div>
            {selected.task && <p className="agent-map-detail-task">{selected.task}</p>}
            {parent && (
              <p className="agent-map-origin">{t('map.from', { name: nameOf(parent) })}</p>
            )}
            <dl className="agent-map-facts">
              <div>
                <dt>{t('card.model')}</dt>
                <dd>{model ? <ModelName model={model} /> : t('card.modelUnknown')}</dd>
              </div>
              {selected.effort && (
                <div>
                  <dt>{t('card.effort')}</dt>
                  <dd>{selected.effort}</dd>
                </div>
              )}
              <div>
                <dt>{t('map.duration')}</dt>
                <dd className="tabular">
                  {formatDuration(
                    selected.startedAt,
                    selected.endedAt ?? lane.endedAt ?? new Date(now).toISOString(),
                  )}
                </dd>
              </div>
              <div>
                <dt>{t('map.tokens')}</dt>
                <dd className="tabular">
                  {totalTokens(selected.tokens).toLocaleString(
                    locale === 'pt-BR' ? 'pt-BR' : 'en-US',
                  )}
                </dd>
              </div>
            </dl>
            <section className="agent-map-instruction" aria-label={t('map.instruction')}>
              <InstructionText
                key={selected.agentId}
                {...instruction}
                defaultOpen
                summaryLabel={t('map.instruction')}
              />
            </section>
            <p className="agent-map-id">
              <span>{t('map.agentId')}</span> <code>{selected.agentId}</code>
            </p>
          </div>
          <footer className="agent-map-footer">
            <button
              type="button"
              className="agent-map-open-activity pressable"
              onClick={() => onOpenAgent(selected.agentId)}
            >
              <Icon name="open" size={16} />
              {t('map.openActivity')}
            </button>
          </footer>
        </div>
      )}
    </dialog>,
    document.body,
  );
};
