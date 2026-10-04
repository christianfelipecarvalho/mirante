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
import { ModelName } from './ModelName';
import { useI18n, type Translate } from '../lib/i18n';
import { livenessOf } from '../lib/liveness';
import { usePointerGlow } from '../lib/pointer-glow';
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
      // No subject means the rest of the team — its coordinator, usually —
      // rather than agents this one started.
      return waitingOn.subject
        ? t('waiting.subagent', { subject: waitingOn.subject })
        : t('waiting.team');
    case 'approval':
      return waitingOn.detail
        ? `${t('waiting.approval', { subject: waitingOn.subject ?? '' })}: ${waitingOn.detail}`
        : t('waiting.approval', { subject: waitingOn.subject ?? '' });
    case 'input':
      // The question itself, when the agent asked one: "waiting for your
      // reply" alone does not say what the reply is to.
      return waitingOn.detail ? `${t('waiting.input')}: ${waitingOn.detail}` : t('waiting.input');
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

/** Where a card can be found on the page, so a request elsewhere can lead to it. */
export const agentAnchor = (sessionId: string, agentId: string): string =>
  `agent-${sessionId}-${agentId}`;

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
  const onPointerMove = usePointerGlow();
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
      id={agentAnchor(card.sessionId, card.agentId)}
      className={`glow-card lantern relative overflow-hidden rounded-lg border py-3 pl-4 pr-3 ${
        onOpen ? 'cursor-pointer' : ''
      }`}
      // Lit while the agent is really working, warned while it waits on a
      // person, dark at rest. See the card section in index.css.
      data-life={liveness === 'live' ? 'working' : waiting ? 'waiting' : 'rest'}
      data-beam={liveness === 'live'}
      style={
        {
          // The light is the agent's own colour, so a lane of working agents
          // reads as several lit windows rather than one alarm.
          '--glow': waiting ? 'var(--status-warning)' : color,
        } as CSSProperties
      }
      onPointerMove={onPointerMove}
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
        className="card-rail absolute inset-y-0 left-0 w-[3px]"
        style={{ background: waiting ? 'var(--status-warning)' : color }}
      />
      <header className="flex items-start gap-2.5">
        <span
          className="card-mark grid size-8 shrink-0 place-items-center rounded-full"
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
            {/*
              The name is the card's control, not the card itself. An <article>
              with an onClick is unreachable by keyboard and announced as
              nothing; a button around the whole card cannot hold the approval
              buttons inside it. So the name carries the action, exactly as the
              lane header above already does.
            */}
            {onOpen ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen();
                }}
                className="cursor-pointer truncate text-left text-[13px] font-semibold text-[var(--text-primary)] transition-colors duration-200 hover:text-[var(--accent)]"
              >
                {identity.name}
              </button>
            ) : (
              <span className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
                {identity.name}
              </span>
            )}
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

      {/*
        What this agent was asked to do, quoted. Same geometry as the waiting
        block below — one kind of quoted thing on a card — but ruled in the
        agent's own colour, because the status palette is reserved for state.
      */}
      {!isRoot && <BriefBlock card={card} color={color} />}

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

      {/* Tokens and time are what people come back to the footer for, so the
          figures take the primary colour and their unit the secondary. */}
      <footer className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-secondary)]">
        <span className="tabular">
          <span className="font-medium text-[var(--text-primary)]">
            {formatTokens(card.tokens)}
          </span>{' '}
          {t('card.tokens')}
        </span>
        <span className="tabular font-medium text-[var(--text-primary)]">
          {formatDuration(card.startedAt, card.endedAt)}
        </span>
        {/* Where the raw id used to be, now readable and at the same weight as
            the figures beside it. */}
        <ModelName model={card.model} />
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
 * The instruction this agent was given.
 *
 * The task line above is the headline its caller typed — three to eight words.
 * This is the work itself, and for a subagent it is the only thing that says
 * why it exists. When the board never saw the spawn there is nothing to quote,
 * and a card with no task either says so rather than leaving a silent gap.
 */
const BriefBlock = ({ card, color }: { card: Card; color: string }) => {
  const { t } = useI18n();

  if (!card.brief) {
    if (card.task) return null;
    return (
      <div
        className="mt-2 rounded border-l-2 py-1 pl-2 text-[11px] text-[var(--text-secondary)]"
        style={{ borderColor: 'var(--baseline)', background: 'var(--surface-2)' }}
      >
        <span className="flex items-center gap-1.5">
          <Icon name="unknown" size={11} />
          {t('brief.missing')}
        </span>
        <span className="mt-0.5 block">{t('brief.missingWhy')}</span>
      </div>
    );
  }

  const cut =
    card.briefCharCount !== undefined && card.briefCharCount > card.brief.length
      ? t('brief.kept', { kept: card.brief.length, total: card.briefCharCount })
      : undefined;

  return (
    <div
      className="mt-2 rounded border-l-2 py-1 pl-2 text-[12px]"
      style={{ borderColor: color, background: 'var(--surface-2)' }}
    >
      <blockquote className="line-clamp-2 text-[var(--text-primary)]" title={card.brief}>
        {card.brief}
      </blockquote>
      {cut && <div className="mt-0.5 text-[10px] text-[var(--text-secondary)]">{cut}</div>}
    </div>
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
  // The agent's own sentence, unquoted: it is not being cited, it is speaking.
  const fromAgent = !current && card.lastActivityKind === 'said';
  const text = fromPerson ? `“${previous ?? ''}”` : (current ?? previous);

  return (
    <div className="mt-2 flex items-start gap-1.5 text-[12px]">
      {/* Still: the one thing on the board that moves on its own is a project
          waiting on you, and it only stands out if nothing else pulses. */}
      <span className="mt-[2px] shrink-0" style={{ color: running ? color : 'var(--text-muted)' }}>
        <Icon
          name={running ? 'play' : fromPerson ? 'prompt' : fromAgent ? 'speech' : 'back'}
          size={11}
        />
      </span>
      <div className="min-w-0">
        <div
          // What the agent wrote gets two lines and its full colour: it is the
          // one line on the card a person reads rather than scans.
          className={fromAgent ? 'line-clamp-2' : 'truncate'}
          style={{
            color: current || fromAgent ? 'var(--text-secondary)' : 'var(--text-muted)',
          }}
          title={text}
        >
          {text}
        </div>
        {!current && (
          <div className="text-[10px] text-[var(--text-muted)]">
            {fromPerson
              ? t('card.lastMessage')
              : fromAgent
                ? t('card.wrote')
                : t('card.lastAction')}
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
