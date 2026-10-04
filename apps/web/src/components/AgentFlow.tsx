import { useEffect, useId, useMemo, useRef, type CSSProperties } from 'react';
import type { AgentCard, SessionLane } from '@mirante/shared';
import { isWaitingState, livenessOf } from '@mirante/shared';
import { agentOrdinals, describeAgent } from '../lib/agents';
import {
  buildAgentFlow,
  FLOW_NODE_HEIGHT,
  FLOW_NODE_WIDTH,
  type AgentFlowEdgeState,
} from '../lib/agent-flow';
import { formatDuration } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { agentIcon } from '../lib/icons';
import { agentColor } from '../lib/palette';
import { modelLabel } from '../lib/models';
import { waitingText } from './AgentCard';
import { Icon } from './Icon';
import { ModelName } from './ModelName';
import { StateBadge } from './StateBadge';

export type AgentFlowProps = {
  lane: SessionLane;
  now: number;
  onOpen?: (agentId: string) => void;
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
export const AgentFlow = ({ lane, now, onOpen, compact = false }: AgentFlowProps) => {
  const { t } = useI18n();
  const arrowId = `flow-arrow-${useId().replaceAll(':', '')}`;
  const shell = useRef<HTMLDivElement>(null);
  const positioned = useRef(false);
  const flow = useMemo(() => buildAgentFlow(lane, now), [lane, now]);
  const nodeById = new Map(flow.nodes.map((node) => [node.card.agentId, node]));
  const ordinals = agentOrdinals(lane.cards, (card) => describeAgent(card, t).name);
  const colorById = new Map(
    lane.cards
      .filter((card) => card.agentId !== 'main')
      .map((card, index) => [card.agentId, agentColor(index)]),
  );
  colorById.set('main', 'var(--accent)');

  useEffect(() => {
    const root = flow.nodes.find((node) => node.card.agentId === 'main') ?? flow.nodes[0];
    // A large team centers its parent among many rows. Bring that parent into
    // view once, without fighting subsequent manual scrolling.
    if (!positioned.current && shell.current && root) {
      shell.current.scrollTop = Math.max(
        0,
        root.y + FLOW_NODE_HEIGHT / 2 - shell.current.clientHeight / 2,
      );
      positioned.current = true;
    }
  }, [flow.nodes]);

  return (
    <div
      ref={shell}
      role="region"
      aria-label={t('detail.tab.flow')}
      tabIndex={0}
      className="agent-flow-shell overflow-auto rounded-lg border"
      data-compact={compact}
      style={{ borderColor: 'var(--hairline)' }}
    >
      <div
        className="agent-flow-canvas relative"
        style={{ width: flow.width, height: flow.height } as CSSProperties}
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
          {flow.edges.map((edge) => {
            const parent = nodeById.get(edge.parentId);
            const child = nodeById.get(edge.childId);
            if (!parent || !child) return null;
            const outbound = edge.direction !== 'inbound';
            const from = outbound ? parent : child;
            const to = outbound ? child : parent;
            const x1 = from.x + (outbound ? FLOW_NODE_WIDTH : 0);
            const x2 = to.x + (outbound ? 0 : FLOW_NODE_WIDTH);
            const y1 = from.y + FLOW_NODE_HEIGHT / 2;
            const y2 = to.y + FLOW_NODE_HEIGHT / 2;
            const bend = Math.abs(x2 - x1) * 0.48;
            const path = `M ${x1} ${y1} C ${x1 + (outbound ? bend : -bend)} ${y1}, ${x2 - (outbound ? bend : -bend)} ${y2}, ${x2} ${y2}`;
            const color = colorById.get(edge.childId) ?? 'var(--accent)';
            const midX = (x1 + x2) / 2;
            const midY = (y1 + y2) / 2;
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
                <g transform={`translate(${midX}, ${midY})`}>
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

        {flow.nodes.map((node) => (
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
            onOpen={onOpen}
          />
        ))}
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
  onOpen,
}: {
  card: AgentCard;
  model?: string | undefined;
  color: string;
  x: number;
  y: number;
  now: number;
  sessionEnded: boolean;
  ordinal?: number | undefined;
  onOpen?: ((agentId: string) => void) | undefined;
}) => {
  const { t } = useI18n();
  const identity = describeAgent(card, t);
  const waiting = isWaitingState(card.status.state);
  const liveness = livenessOf(card, now, sessionEnded);
  const working = !card.endedAt && liveness === 'live';
  const closed =
    Boolean(card.endedAt) || card.status.state === 'done' || card.status.state === 'error';
  const override =
    card.status.state === 'error' && card.stoppedAtLimit
      ? ('interrupted' as const)
      : liveness === 'silent'
        ? ('silent' as const)
        : undefined;
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
      className="agent-flow-node absolute overflow-hidden rounded-lg border p-2.5 text-left"
      data-agent-id={card.agentId}
      data-life={
        working
          ? 'working'
          : override === 'silent'
            ? 'silent'
            : closed
              ? 'closed'
              : waiting
                ? 'waiting'
                : 'idle'
      }
      style={
        {
          left: x,
          top: y,
          width: FLOW_NODE_WIDTH,
          height: FLOW_NODE_HEIGHT,
          '--node-color': color,
        } as CSSProperties
      }
    >
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: color }} />
      <span className="flex items-start gap-2">
        <span
          className="grid size-7 shrink-0 place-items-center rounded-full"
          style={{ color, background: `color-mix(in oklab, ${color} 18%, transparent)` }}
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
          {working && card.runningChildren > 0
            ? t('flow.children', { n: card.runningChildren })
            : closed
              ? t('flow.finished')
              : t('flow.connected')}
        </span>
        <span className="tabular shrink-0">
          {formatDuration(card.startedAt, card.endedAt ?? new Date(now).toISOString())}
        </span>
      </span>
    </button>
  );
};
