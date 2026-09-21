import type { CSSProperties } from 'react';
import type { AgentCard as Card, PendingApproval, WaitingOn } from '@mirante/shared';
import { isWaitingState } from '@mirante/shared';
import { formatDuration, formatTokens, formatWaitingFor } from '../lib/format';
import {
  ROLE_ICON,
  agentRoleKey,
  definitionColor,
  describeAgent,
  type AgentDefinition,
} from '../lib/agents';
import { agentIcon } from '../lib/icons';
import { Icon, type IconName } from './Icon';
import { useI18n, type Translate } from '../lib/i18n';
import { livenessOf } from '../lib/liveness';
import { StateBadge } from './StateBadge';

/**
 * The waiting reason, in the reader's language.
 *
 * The daemon writes an English `summary` and, where it can, the reason as a
 * value plus its subject. Prefer the value — a sentence written by the server
 * cannot be translated — and fall back to the summary so a reason Mirante does
 * not yet model still reaches the screen.
 */
export const waitingText = (waitingOn: WaitingOn, t: Translate): string => {
  switch (waitingOn.reason) {
    case 'subagent':
      return t('waiting.subagent', { subject: waitingOn.subject ?? '' });
    case 'approval':
      return waitingOn.detail
        ? `${t('waiting.approval', { subject: waitingOn.subject ?? '' })}: ${waitingOn.detail}`
        : t('waiting.approval', { subject: waitingOn.subject ?? '' });
    case 'input':
      return t('waiting.input');
    case 'plan_limit': {
      const window = waitingOn.subject;
      return window === 'fiveHour' || window === 'sevenDay' || window === 'spendLimit'
        ? t(`waiting.plan_limit.${window}`)
        : waitingOn.summary;
    }
    default:
      return waitingOn.summary;
  }
};

export type AgentCardProps = {
  card: Card;
  color: string;
  /** Position among agents sharing a type, when there is more than one. */
  ordinal?: number | undefined;
  /** The agent's own definition from `.claude/agents`, when it has one. */
  definition?: AgentDefinition | undefined;
  approval?: PendingApproval | undefined;
  onDecide: (requestId: string, behavior: 'allow' | 'deny') => void;
  onOpen?: (() => void) | undefined;
  iconOverrides?: Record<string, IconName>;
  /** The board's clock. Decides whether a working card has gone silent. */
  now?: number | undefined;
  /** The session this card belongs to has ended, so nothing in it is running. */
  sessionEnded?: boolean | undefined;
};

export const AgentCardView = ({
  card,
  color: assignedColor,
  ordinal,
  definition,
  approval,
  onDecide,
  onOpen,
  iconOverrides,
  now,
  sessionEnded = false,
}: AgentCardProps) => {
  const { t } = useI18n();
  // An author who gave their agent a colour gets it; the assigned slot is a
  // fallback for agents that never declared one.
  const color = definitionColor(definition) ?? assignedColor;
  // "Arquiteto" identifies this agent; "general-purpose" is what it happens to
  // be built from. The identifying name leads and the type becomes small print.
  const identity = describeAgent(card, t);
  const waiting = isWaitingState(card.status.state);
  const isRoot = card.agentId === 'main';
  // A card's state is a claim; how recently it was heard from decides whether
  // the claim is shown as fact. See lib/liveness.
  const liveness = livenessOf(card, now ?? Date.now(), sessionEnded);
  const running = card.status.state === 'tool_running' && liveness === 'live';
  const override =
    card.status.state === 'error' && card.stoppedAtLimit
      ? ('interrupted' as const)
      : liveness === 'silent'
        ? ('silent' as const)
        : undefined;
  const badgeTitle =
    override === 'silent' && card.lastEventAt
      ? t('card.silentFor', {
          d: formatDuration(card.lastEventAt, new Date(now ?? Date.now()).toISOString()),
        })
      : undefined;

  return (
    <article
      className={`pressable relative overflow-hidden rounded-lg border py-3 pl-4 pr-3 focus-within:border-[var(--accent)] ${
        onOpen ? 'cursor-pointer hover:border-[var(--accent)]' : ''
      }`}
      style={{
        background: 'var(--surface-1)',
        borderColor: waiting
          ? 'color-mix(in oklab, var(--status-warning) 45%, var(--hairline))'
          : 'var(--hairline)',
      }}
      onClick={onOpen}
    >
      {/*
        A rail rather than a badge: the agent's colour runs the height of its
        card, so a lane of them reads as a set of channels you can scan down
        instead of a grid of identical boxes. When the card is blocked the rail
        switches to the status colour, which is the one thing worth catching
        from across the room.
      */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: waiting ? 'var(--status-warning)' : color }}
      />
      {liveness === 'live' && (
        <span
          aria-hidden="true"
          className="card-loading"
          style={{ '--bar': color } as CSSProperties}
        />
      )}
      <header className="flex items-start gap-2.5">
        <span
          className="grid size-8 shrink-0 place-items-center rounded-full"
          style={{ background: `color-mix(in oklab, ${color} 18%, transparent)`, color }}
        >
          {/* An inferred role has a mark of its own; otherwise the type decides. */}
          <Icon
            name={
              identity.role
                ? ROLE_ICON[identity.role]
                : agentIcon(card.agentType, card.agentId, iconOverrides, card.task)
            }
            size={16}
          />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
              {identity.name}
            </span>
            {/* Agents sharing a type are otherwise impossible to tell apart. */}
            {ordinal !== undefined && (
              <span
                className="tabular shrink-0 rounded px-1 text-[10px] font-medium"
                style={{ background: `color-mix(in oklab, ${color} 18%, transparent)`, color }}
              >
                {ordinal}
              </span>
            )}
            {!isRoot && (
              <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
                {identity.typeLabel ?? t('card.subagent')}
              </span>
            )}
          </div>
          {/*
            What this agent is for. The task it was given wins over any generic
            description: three agents can all be "general-purpose" while one is
            the designer, one the architect and one the PM, and only the task
            says which is which.
          */}
          <div
            className="truncate text-[11px]"
            style={{ color: card.task ? 'var(--text-secondary)' : 'var(--text-muted)' }}
            title={card.task ?? definition?.description}
          >
            {identity.detail ?? definition?.description ?? t(agentRoleKey(card) as 'role.general')}
          </div>
        </div>

        <StateBadge status={card.status} override={override} title={badgeTitle} />
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
          <span
            className="ml-auto flex items-center gap-1 text-[10px]"
            style={{ color: 'var(--accent)' }}
          >
            <Icon name="down" size={11} />
            {t('card.agentsRunning', { count: card.runningChildren })}
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
  if (card.status.state === 'error' && card.stoppedAtLimit) {
    return <LimitStop limit={card.stoppedAtLimit} />;
  }
  const current = card.activity;
  const previous = card.lastActivity;
  if (!current && !previous) return null;
  // What the person typed is quoted under the prompt chevron: "“.”" reads as a
  // character someone typed, where "Prompt: ." read as a broken sentence.
  const fromPerson = !current && card.lastActivityKind === 'prompt';
  const text = fromPerson ? `“${previous ?? ''}”` : (current ?? previous);

  return (
    <div className="mt-2 flex items-start gap-1.5 text-[12px]">
      {/* Still: the one thing on the board that moves on its own is a project
          waiting on you, and it only stands out if nothing else pulses. */}
      <span className="mt-[2px] shrink-0" style={{ color: running ? color : 'var(--text-muted)' }}>
        <Icon name={running ? 'play' : fromPerson ? 'prompt' : 'back'} size={11} />
      </span>
      <div className="min-w-0">
        <div
          className="truncate"
          style={{ color: current ? 'var(--text-secondary)' : 'var(--text-muted)' }}
          title={text}
        >
          {text}
        </div>
        {!current && (
          <div className="text-[10px] text-[var(--text-muted)]">
            {fromPerson ? t('card.lastMessage') : t('card.lastAction')}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * Why an agent stopped, when a plan limit stopped it.
 *
 * The generic error line said "Turn ended with an error", which is true and
 * leaves the reader to guess whether something broke. This names the window and
 * when it reopens, which is also the earliest the work can be run again.
 */
const LimitStop = ({ limit }: { limit: NonNullable<Card['stoppedAtLimit']> }) => {
  const { t } = useI18n();
  const what =
    limit.window === 'fiveHour'
      ? t('stopped.fiveHour')
      : limit.window === 'sevenDay'
        ? t('stopped.sevenDay')
        : t('stopped.plan');

  const reopens = (() => {
    if (limit.resetsAt === undefined) return undefined;
    const at = new Date(limit.resetsAt * 1000);
    if (at.getTime() <= Date.now()) return t('stopped.reopened');
    const sameDay = at.toDateString() === new Date().toDateString();
    const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return t('stopped.reopensAt', {
      time: sameDay
        ? time
        : `${at.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })} ${time}`,
    });
  })();

  return (
    <div className="mt-2 flex items-start gap-1.5 text-[12px]">
      <span className="mt-[2px] shrink-0" style={{ color: 'var(--status-serious)' }}>
        <Icon name="pause" size={11} />
      </span>
      <div className="min-w-0">
        <div className="text-[var(--text-primary)]">{what}</div>
        {reopens && <div className="text-[11px] text-[var(--text-muted)]">{reopens}</div>}
      </div>
    </div>
  );
};
