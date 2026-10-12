import { useEffect, useLayoutEffect, useId, useMemo, useRef, type CSSProperties } from 'react';
import type { AgentCard, SessionLane } from '@mirante/shared';
import { completionOf, isWaitingState, livenessOf } from '@mirante/shared';
import { agentOrdinals, describeAgent } from '../lib/agents';
import {
  buildAgentFlow,
  agentFlowPath,
  filterInactiveAgents,
  stableAgentCards,
  routeAgentFlow,
  reverseAgentFlowPath,
  type AgentFlowPath,
  FLOW_NODE_HEIGHT,
  FLOW_NODE_WIDTH,
  type AgentFlowEdgeState,
} from '../lib/agent-flow';
import { MAX_FLOW_ZOOM, MIN_FLOW_ZOOM, visibleFlowBounds } from '../lib/flow-viewport';
import { useFlowViewport } from '../lib/use-flow-viewport';
import { useFlowFilter } from '../lib/use-flow-filter';
import { useFlowPan } from '../lib/use-flow-pan';
import { positionAgentFlow } from '../lib/flow-positions';
import { useFlowPositions } from '../lib/use-flow-positions';
import { useFlowNodeDrag } from '../lib/use-flow-node-drag';
import { scrollToFlowPoint } from '../lib/flow-viewport';
import { formatDuration } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { agentIcon } from '../lib/icons';
import { agentColor } from '../lib/palette';
import { modelLabel } from '../lib/models';
import { usePointerGlow } from '../lib/pointer-glow';
import { waitingText } from './AgentCard';
import { Icon } from './Icon';
import { ModelName } from './ModelName';
import { StateBadge } from './StateBadge';
import { AgentProgress } from './AgentProgress';

export type AgentFlowProps = {
  lane: SessionLane;
  now: number;
  onOpen?: (agentId: string) => void;
  onOpenMap?: (agentOrder: readonly string[]) => void;
  compact?: boolean;
};

const EDGE_LABEL: Record<
  AgentFlowEdgeState,
  | 'flow.edge.delegating'
  | 'flow.edge.active'
  | 'flow.edge.waiting'
  | 'flow.edge.returning'
  | 'flow.edge.closed'
  | 'state.idle'
  | 'state.silent'
> = {
  delegating: 'flow.edge.delegating',
  active: 'flow.edge.active',
  waiting: 'flow.edge.waiting',
  returning: 'flow.edge.returning',
  closed: 'flow.edge.closed',
  idle: 'state.idle',
  silent: 'state.silent',
};

/** A live, code-native agent graph: no canvas, so labels and controls stay accessible. */
export const AgentFlow = ({ lane, now, onOpen, onOpenMap, compact = false }: AgentFlowProps) => {
  const { t } = useI18n();
  const arrowId = `flow-arrow-${useId().replaceAll(':', '')}`;
  const shell = useRef<HTMLDivElement>(null);
  const positioned = useRef<string | undefined>(undefined);
  const { onlyWorking, setOnlyWorking } = useFlowFilter();
  useFlowPan(shell);
  const regionId = useId();
  const remembered = useRef<{ sessionId: string; order: readonly string[] }>({
    sessionId: lane.sessionId,
    order: [],
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
  }, [lane.sessionId, ordered]);
  const stableLane = useMemo(() => ({ ...lane, cards: ordered.cards }), [lane, ordered.cards]);
  const automaticFlow = useMemo(() => buildAgentFlow(stableLane, now), [stableLane, now]);
  const { positions, savePosition, resetPositions } = useFlowPositions(lane.sessionId);
  const footprint = useRef<{ sessionId: string; width: number; height: number } | undefined>(
    undefined,
  );
  const savedFlow = useMemo(
    () =>
      positionAgentFlow(
        automaticFlow,
        positions,
        footprint.current?.sessionId === lane.sessionId ? footprint.current : undefined,
      ),
    [automaticFlow, positions, lane.sessionId],
  );
  const zoomRef = useRef(1);
  const { draft, announcement } = useFlowNodeDrag(shell, {
    sessionId: lane.sessionId,
    nodes: savedFlow.nodes,
    content: savedFlow,
    zoom: () => zoomRef.current,
    save: savePosition,
  });
  const flow = useMemo(
    () => (draft ? positionAgentFlow(savedFlow, { [draft.agentId]: draft.point }) : savedFlow),
    [savedFlow, draft],
  );
  useLayoutEffect(() => {
    // Keep the last committed footprint while this view is open. Shrinking it
    // on drop would move a small, centered map away from the released pointer.
    if (!draft)
      footprint.current = { sessionId: lane.sessionId, width: flow.width, height: flow.height };
  }, [flow.width, flow.height, lane.sessionId, draft]);
  const visible = useMemo(
    () => (onlyWorking ? filterInactiveAgents(flow, now, Boolean(lane.endedAt)) : flow),
    [flow, onlyWorking, now, lane.endedAt],
  );
  const routeCache = useRef<{ key: string; paths: Map<string, AgentFlowPath> } | undefined>(
    undefined,
  );
  const routes = useMemo(() => {
    const key = JSON.stringify([
      visible.nodes.map((node) => [node.card.agentId, node.x, node.y]),
      visible.edges.map((edge) => [edge.id, edge.parentId, edge.childId]),
    ]);
    if (routeCache.current?.key === key && !draft) return routeCache.current;
    // Dense maps keep their settled corridors while dragging. Recompute attached
    // endpoints each frame, then route all visible obstacles once on release.
    if (draft && visible.nodes.length > 32) {
      const nodes = new Map(visible.nodes.map((node) => [node.card.agentId, node]));
      const paths = new Map(
        visible.edges.map((edge) => {
          const cached = routeCache.current?.paths.get(edge.id);
          return [
            edge.id,
            cached && edge.parentId !== draft.agentId && edge.childId !== draft.agentId
              ? cached
              : agentFlowPath(nodes.get(edge.parentId)!, nodes.get(edge.childId)!),
          ];
        }),
      );
      return { key: `drag:${key}`, paths };
    }
    return { key, paths: routeAgentFlow(visible) };
  }, [visible, draft]);
  useEffect(() => {
    routeCache.current = routes;
  }, [routes]);
  const bounds = useMemo(
    () =>
      visibleFlowBounds(
        visible.nodes,
        visible.edges.flatMap((edge) => {
          const path = routes.paths.get(edge.id);
          return path ? [path] : [];
        }),
      ),
    [visible, routes],
  );
  const { zoom, zoomTo, zoomBy, fit, stage } = useFlowViewport(shell, flow, bounds);
  useLayoutEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  const workingCount = flow.nodes.filter(
    ({ card }) => !card.endedAt && livenessOf(card, now, Boolean(lane.endedAt)) === 'live',
  ).length;
  const connected = new Set(flow.edges.map((edge) => edge.childId));
  const nodeById = new Map(flow.nodes.map((node) => [node.card.agentId, node]));
  const ordinals = agentOrdinals(ordered.cards, (card) => describeAgent(card, t).name);
  const colorById = new Map(
    ordered.cards
      .filter((card) => card.agentId !== 'main')
      .map((card, index) => [card.agentId, agentColor(index)]),
  );
  colorById.set('main', 'var(--accent)');

  const announcedCard = lane.cards.find((card) => card.agentId === announcement?.agentId);
  const rootPoint = () => {
    const root = flow.nodes.find((node) => node.card.agentId === 'main');
    return root
      ? { x: root.x + FLOW_NODE_WIDTH / 2, y: root.y + FLOW_NODE_HEIGHT / 2 }
      : { x: flow.width / 2, y: flow.height / 2 };
  };
  const centerRoot = () => {
    if (!shell.current) return;
    const viewport = shell.current;
    const scroll = scrollToFlowPoint(
      flow,
      { width: viewport.clientWidth, height: viewport.clientHeight },
      zoom,
      rootPoint(),
    );
    viewport.scrollTo({
      left: scroll.x,
      top: scroll.y,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  };

  useEffect(() => {
    // Center once per session; activity updates and filtering must never fight
    // the person's manual exploration of the graph.
    if (positioned.current !== lane.sessionId && shell.current && flow.nodes.length > 0) {
      const viewport = shell.current;
      const scroll = scrollToFlowPoint(
        flow,
        { width: viewport.clientWidth, height: viewport.clientHeight },
        zoom,
        rootPoint(),
      );
      viewport.scrollLeft = scroll.x;
      viewport.scrollTop = scroll.y;
      positioned.current = lane.sessionId;
    }
  }, [lane.sessionId, flow.nodes.length]);

  return (
    <div className="agent-flow">
      <div className="agent-flow-toolbar">
        <div role="group" aria-label={t('flow.filter')} className="agent-flow-filter">
          {[false, true].map((value) => (
            <button
              key={String(value)}
              type="button"
              className="pressable agent-flow-tool"
              aria-controls={regionId}
              aria-describedby={`${regionId}-filter-hint`}
              aria-pressed={onlyWorking === value}
              onClick={() => setOnlyWorking(value)}
            >
              {t(value ? 'flow.onlyWorking' : 'flow.allAgents')}
            </button>
          ))}
        </div>
        <span role="status" className="tabular text-[11px] text-[var(--text-muted)]">
          {t('flow.visible', { shown: visible.nodes.length, total: flow.nodes.length })}
        </span>
        {onOpenMap && (
          <button
            type="button"
            className="pressable agent-flow-tool"
            aria-haspopup="dialog"
            onClick={() => onOpenMap(ordered.order)}
            disabled={!flow.nodes.length}
          >
            <Icon name="branch" size={14} />
            {t('map.open')}
          </button>
        )}
        <div className="agent-flow-zoom" role="group" aria-label={t('flow.zoomControls')}>
          <button
            type="button"
            className="pressable agent-flow-tool"
            aria-label={t('flow.zoomOut')}
            title={t('flow.zoomOut')}
            disabled={zoom <= MIN_FLOW_ZOOM || !flow.nodes.length}
            onClick={() => zoomBy(1 / 1.25)}
            aria-controls={regionId}
          >
            <Icon name="minus" size={15} />
          </button>
          <button
            type="button"
            className="pressable agent-flow-tool agent-flow-zoom-value tabular"
            aria-label={`${Math.round(zoom * 100)}% · ${t('flow.zoomReset')}`}
            title={t('flow.zoomReset')}
            onClick={() => zoomTo(1)}
            disabled={!flow.nodes.length}
            aria-controls={regionId}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            className="pressable agent-flow-tool"
            aria-label={t('flow.zoomIn')}
            title={t('flow.zoomIn')}
            disabled={zoom >= MAX_FLOW_ZOOM || !flow.nodes.length}
            onClick={() => zoomBy(1.25)}
            aria-controls={regionId}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
        <button
          type="button"
          className="pressable agent-flow-tool"
          onClick={fit}
          disabled={!flow.nodes.length}
          aria-controls={regionId}
        >
          <Icon name="fit" size={14} />
          {t('flow.fit')}
        </button>
        <button
          type="button"
          onClick={centerRoot}
          disabled={flow.nodes.length === 0}
          className="pressable agent-flow-tool"
          aria-controls={regionId}
        >
          <Icon name="compass" size={13} />
          {t(
            lane.cards.some((card) => card.agentId === 'main')
              ? 'flow.centerMain'
              : 'flow.centerView',
          )}
        </button>
        <button
          type="button"
          className="pressable agent-flow-tool"
          onClick={() => {
            footprint.current = undefined;
            resetPositions();
          }}
          disabled={!Object.keys(positions).length}
          aria-controls={regionId}
        >
          <Icon name="refresh" size={14} />
          {t('flow.resetPositions')}
        </button>
        <p
          id={`${regionId}-filter-hint`}
          className={onlyWorking ? 'agent-flow-filter-hint' : 'sr-only'}
        >
          {onlyWorking && workingCount === 0 && <span>{t('flow.noWorking')} </span>}
          {t('flow.filterHint')}
        </p>
        <p id={`${regionId}-zoom-hint`} className="sr-only">
          {t('flow.zoomHint')}
        </p>
        <p id={`${regionId}-drag-hint`} className="agent-flow-filter-hint">
          {t('flow.dragHint')} {t('flow.panHint')}
        </p>
        <p className="sr-only" role="status" aria-live="polite">
          {announcement &&
            t('flow.positionMoved', {
              name: announcedCard ? describeAgent(announcedCard, t).name : announcement.agentId,
              x: Math.round(announcement.point.x),
              y: Math.round(announcement.point.y),
            })}
        </p>
      </div>
      <div
        ref={shell}
        id={regionId}
        role="region"
        aria-label={t('detail.tab.flow')}
        tabIndex={0}
        aria-describedby={`${regionId}-zoom-hint`}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          const key = event.key.toLowerCase();
          if (!['+', '=', '-', '0', 'f'].includes(key)) return;
          event.preventDefault();
          if (key === '+' || key === '=') zoomBy(1.25);
          else if (key === '-') zoomBy(1 / 1.25);
          else if (key === '0') zoomTo(1);
          else fit();
        }}
        className="agent-flow-shell overflow-auto rounded-lg border"
        data-compact={compact}
        style={{ borderColor: 'var(--hairline)' }}
      >
        <div className="agent-flow-stage" style={{ width: stage.width, height: stage.height }}>
          <div
            className="agent-flow-canvas absolute"
            style={
              {
                width: flow.width,
                height: flow.height,
                left: stage.x,
                top: stage.y,
                transform: `scale(${zoom})`,
              } as CSSProperties
            }
          >
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-visible"
              width={flow.width}
              height={flow.height}
            >
              <defs>
                <marker
                  id={arrowId}
                  markerWidth="7"
                  markerHeight="7"
                  refX="5.5"
                  refY="3.5"
                  orient="auto"
                >
                  <path d="M0,0 L7,3.5 L0,7 z" fill="context-stroke" />
                </marker>
              </defs>
              {visible.edges.map((edge) => {
                const parent = nodeById.get(edge.parentId);
                const child = nodeById.get(edge.childId);
                if (!parent || !child) return null;
                const outbound = edge.direction !== 'inbound';
                const route = routes.paths.get(edge.id);
                if (!route) return null;
                const { path, midpoint } = outbound ? route : reverseAgentFlowPath(route);
                const color = colorById.get(edge.childId) ?? 'var(--accent)';
                return (
                  <g
                    key={edge.id}
                    className="agent-flow-edge"
                    data-state={edge.state}
                    data-moving={edge.direction !== 'none'}
                    style={{ '--edge-color': color } as CSSProperties}
                  >
                    <path className="agent-flow-edge-track" d={path} />
                    <path
                      className="agent-flow-edge-signal"
                      d={path}
                      markerEnd={edge.direction === 'none' ? undefined : `url(#${arrowId})`}
                    />
                    <g transform={`translate(${midpoint.x}, ${midpoint.y})`}>
                      <rect
                        className="agent-flow-edge-label-bg"
                        x="-36"
                        y="-9"
                        width="72"
                        height="18"
                        rx="9"
                      />
                      <text
                        className="agent-flow-edge-label"
                        textAnchor="middle"
                        dominantBaseline="central"
                      >
                        {t(EDGE_LABEL[edge.state])}
                      </text>
                    </g>
                  </g>
                );
              })}
            </svg>

            {visible.nodes.map((node) => (
              <FlowNode
                key={node.card.agentId}
                card={node.card}
                model={node.card.model ?? (node.card.agentId === 'main' ? lane.model : undefined)}
                color={colorById.get(node.card.agentId) ?? 'var(--agent-neutral)'}
                x={node.x}
                y={node.y}
                now={now}
                sessionEnded={Boolean(lane.endedAt)}
                ordinal={ordinals.get(node.card.agentId)}
                detached={node.card.agentId !== 'main' && !connected.has(node.card.agentId)}
                onOpen={onOpen}
                dragHintId={`${regionId}-drag-hint`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const FlowNode = ({
  card,
  model,
  color,
  x,
  y,
  now,
  sessionEnded,
  ordinal,
  detached,
  onOpen,
  dragHintId,
}: {
  card: AgentCard;
  model?: string | undefined;
  color: string;
  x: number;
  y: number;
  now: number;
  sessionEnded: boolean;
  ordinal?: number | undefined;
  detached: boolean;
  dragHintId: string;
  onOpen?: ((agentId: string) => void) | undefined;
}) => {
  const { t } = useI18n();
  const onPointerMove = usePointerGlow();
  const identity = describeAgent(card, t);
  const waiting = isWaitingState(card.status.state);
  const liveness = livenessOf(card, now, sessionEnded);
  const working = !card.endedAt && liveness === 'live';
  const closed =
    Boolean(card.endedAt) || card.status.state === 'done' || card.status.state === 'error';
  const completion = completionOf(card);
  const override =
    completion === 'interrupted'
      ? ('interrupted' as const)
      : completion === 'unknown'
        ? ('unconfirmed' as const)
        : !completion && liveness === 'silent'
          ? ('silent' as const)
          : undefined;
  const life = working
    ? 'working'
    : override === 'silent'
      ? 'silent'
      : closed
        ? 'closed'
        : waiting
          ? 'waiting'
          : 'idle';
  const activity =
    waiting && card.status.waitingOn
      ? waitingText(card.status.waitingOn, t)
      : override === 'silent'
        ? t('card.silentFor', {
            d: formatDuration(card.lastEventAt ?? card.startedAt, new Date(now).toISOString()),
          })
        : (card.activity ?? card.lastActivity ?? card.task ?? t('state.idle'));

  return (
    <button
      type="button"
      onClick={() => onOpen?.(card.agentId)}
      onPointerMove={onPointerMove}
      className="agent-flow-node glow-card lantern absolute overflow-hidden rounded-lg border p-2.5 text-left"
      aria-describedby={dragHintId}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"
      data-agent-id={card.agentId}
      data-life={life}
      data-beam={working}
      style={
        {
          left: x,
          top: y,
          width: FLOW_NODE_WIDTH,
          height: FLOW_NODE_HEIGHT,
          '--node-color': color,
          '--glow': life === 'waiting' ? 'var(--status-warning)' : color,
        } as CSSProperties
      }
    >
      <span className="pointer-edge" aria-hidden="true" />
      <span
        aria-hidden="true"
        className="card-rail absolute inset-y-0 left-0 w-px"
        style={{ background: 'var(--glow)' }}
      />
      <span className="flex items-start gap-2">
        <span
          className="card-mark grid size-7 shrink-0 place-items-center rounded-full"
          style={{ color, background: `color-mix(in oklab, ${color} 18%, var(--surface-1))` }}
        >
          <Icon name={agentIcon(card.agentType, card.agentId, {}, card.task)} size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-semibold text-[var(--text-primary)]">
            {identity.name}
            {ordinal !== undefined && ` ${ordinal}`}
          </span>
          <span className="block truncate text-[10px] text-[var(--text-muted)]">
            {card.agentId === 'main'
              ? t('card.mainSession')
              : (identity.typeLabel ?? t('card.subagent'))}
          </span>
        </span>
        <AgentProgress card={card} now={now} sessionEnded={sessionEnded} />
      </span>
      <span className="mt-1.5 block">
        <StateBadge status={card.status} override={override} />
      </span>
      <span className="agent-flow-model mt-1 flex min-w-0 items-center gap-1 text-[11px] text-[var(--text-secondary)]">
        {modelLabel(model) ? (
          <>
            <span aria-hidden="true" className="shrink-0">
              {t('card.model')}
            </span>
            <ModelName model={model} />
          </>
        ) : (
          <span className="truncate">{t('card.modelUnknown')}</span>
        )}
      </span>
      <span className="agent-flow-effort mt-1 flex min-w-0 items-center gap-1 text-[11px] text-[var(--text-secondary)]">
        {card.effort ? (
          <>
            <span className="shrink-0">{t('card.effort')}</span>
            <span
              className="truncate font-medium text-[var(--text-primary)]"
              title={`${t('card.effort')} ${card.effort}`}
            >
              {card.effort === 'xhigh' ? 'extra high' : card.effort}
            </span>
          </>
        ) : (
          <span className="truncate">{t('card.effortUnknown')}</span>
        )}
      </span>
      <span
        title={activity}
        className="mt-1 block truncate text-[11px] text-[var(--text-secondary)]"
      >
        {activity}
      </span>
      <span className="mt-1 flex items-center justify-between gap-2 text-[10px] text-[var(--text-muted)]">
        <span className="truncate">
          {completion === 'interrupted'
            ? t('flow.interrupted')
            : completion === 'unknown'
              ? t('flow.unconfirmed')
              : completion === 'failed'
                ? t('state.error')
                : completion === 'completed'
                  ? t('flow.finished')
                  : detached
                    ? t('flow.detached')
                    : working && card.runningChildren > 0
                      ? t('flow.children', { n: card.runningChildren })
                      : t('flow.connected')}
        </span>
        <span className="tabular shrink-0">
          {formatDuration(card.startedAt, card.endedAt ?? new Date(now).toISOString())}
        </span>
      </span>
    </button>
  );
};
