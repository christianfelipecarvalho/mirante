import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { CardStatus } from '@mirante/shared';
import { useFreshIds } from '../lib/fresh';
import { groupStepsByTurn, type Step, type StepKind, type StepStatus } from '../lib/steps';
import { formatClock, formatResetClock, formatSpan, formatWhen } from '../lib/format';
import { useI18n, type Translate } from '../lib/i18n';
import { CATEGORY_COLOR, CATEGORY_ICON, describeTool, isPlumbing } from '../lib/tools';
import { waitingText } from './AgentCard';
import { Icon, type IconName } from './Icon';
import { StateBadge } from './StateBadge';
import { InstructionText } from './InstructionText';
import { InstructionPreview } from './InstructionPreview';

const NON_TOOL_ICON: Record<Exclude<StepKind, 'tool'>, IconName> = {
  prompt: 'prompt',
  instruction: 'handoff',
  said: 'speech',
  agent: 'handoff',
  skill: 'skill',
  permission: 'alert',
  compaction: 'compact',
  error: 'cross',
};

const STATUS_COLOR: Record<StepStatus, string> = {
  running: 'var(--accent)',
  ok: 'var(--text-muted)',
  failed: 'var(--status-critical)',
  info: 'var(--text-secondary)',
  limited: 'var(--status-serious)',
};

/** Error rows name their kind in the reader's language, with a shape of their own. */
const ERROR_META: Record<NonNullable<Step['errorKind']>, IconName> = {
  api: 'cross',
  tool: 'cross',
  internal: 'cross',
  parse: 'unknown',
  rate_limit: 'pause',
};

/**
 * What an error row says. A plan-limit stop uses the card's own words, so the
 * card and the log agree; Claude Code's sentence goes in the tooltip.
 */
const errorWording = (
  step: Step,
  t: Translate,
  now: number,
): { label: string; primary?: string; foreign?: boolean } => {
  if (step.errorKind === 'rate_limit') {
    const window = step.limit?.window;
    const label =
      window === 'fiveHour'
        ? t('stopped.fiveHour')
        : window === 'sevenDay'
          ? t('stopped.sevenDay')
          : t('stopped.plan');
    const resetsAt = step.limit?.resetsAt;
    if (resetsAt === undefined) return { label };
    const time = formatResetClock(resetsAt);
    return {
      label,
      primary:
        resetsAt * 1000 > now
          ? t('stopped.reopensAtLower', { time })
          : t('stopped.reopenedAt', { time }),
    };
  }
  const kind = step.errorKind ?? 'api';
  // Claude Code's own message stays as it wrote it — it is not ours to translate.
  return {
    label: t(`error.${kind}` as 'error.api'),
    ...(step.detail ? { primary: step.detail, foreign: true } : {}),
  };
};

const formatElapsed = (ms: number | undefined): string => {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
};

export type ActivityStreamProps = {
  steps: Step[];
  /** Shown beside each line when the stream mixes several agents. */
  showAgent?: boolean;
  /** Identity colour per agent, so a mixed stream stays readable. */
  colorOf?: (agentId: string) => string;
  /**
   * What to call each agent. The lane knows this and the stream does not: a row
   * that repeats "general-purpose" for three different agents names none of them.
   */
  nameOf?: (agentId: string) => string | undefined;
  /**
   * The session's main card, while the session is open. The newest turn is the
   * ongoing one when this says so, and its header shows the state instead of
   * counts that are still changing.
   */
  liveStatus?: CardStatus | undefined;
  /** An agent filter is on: a turn with nothing by that agent is left out. */
  hideEmpty?: boolean;
  selectedAgentId?: string;
};

const ONGOING = new Set([
  'thinking',
  'tool_running',
  'waiting_approval',
  'waiting_input',
  'waiting_subagent',
  'rate_limited',
]);

/**
 * What happened, grouped under the request that caused it.
 *
 * Newest request first and newest step first inside it — one direction for the
 * whole tab, with the live edge at the top. Only the newest group opens by
 * itself; nothing ever closes by itself, because that would pull content out
 * from under the reader.
 */
export const ActivityStream = ({
  steps,
  showAgent = false,
  colorOf,
  nameOf,
  liveStatus,
  hideEmpty = false,
  selectedAgentId,
}: ActivityStreamProps) => {
  const { t } = useI18n();
  const groups = useMemo(
    () =>
      groupStepsByTurn(steps, selectedAgentId).filter(
        (group) => !hideEmpty || group.steps.length > 0,
      ),
    [steps, hideEmpty, selectedAgentId],
  );
  const ids = useMemo(() => steps.map((step) => step.id), [steps]);
  const fresh = useFreshIds(ids);
  const list = useRef<HTMLDivElement>(null);

  const newest = groups[0]?.promptId;
  const [open, setOpen] = useState<Set<string>>(() => new Set(newest ? [newest] : []));
  const seenNewest = useRef(newest);
  // A new request opens by itself; the ones before it stay as the reader left them.
  useEffect(() => {
    if (!newest || newest === seenNewest.current) return;
    seenNewest.current = newest;
    setOpen((previous) => new Set(previous).add(newest));
  }, [newest]);

  const toggle = (promptId: string) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(promptId)) next.delete(promptId);
      else next.add(promptId);
      return next;
    });

  // The WAI-ARIA disclosure pattern: arrows move between headers, Home and End
  // jump to the ends. Step rows are not tab stops.
  const onHeaderKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const headers = [
      ...(list.current?.querySelectorAll<HTMLButtonElement>('[data-turn-header]') ?? []),
    ];
    const index = headers.indexOf(event.currentTarget);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? headers.length - 1
          : event.key === 'ArrowDown'
            ? Math.min(headers.length - 1, index + 1)
            : Math.max(0, index - 1);
    headers[next]?.focus();
    event.preventDefault();
  };

  if (groups.length === 0) {
    return (
      <p className="px-3 py-10 text-center text-[12px] text-[var(--text-muted)]">
        {t('detail.activity.empty')}
      </p>
    );
  }

  return (
    <div ref={list}>
      {groups.map((group, index) => {
        const expanded = open.has(group.promptId);
        const ongoing = index === 0 && liveStatus !== undefined && ONGOING.has(liveStatus.state);
        const panel = `turn-${group.promptId}`;
        return (
          <section
            key={group.promptId}
            className="border-b"
            style={{ borderColor: 'var(--hairline)' }}
          >
            {/* Sticky inside the scroll container, so a long open turn keeps its
                request in view. No box per group: a hairline between them. */}
            <h3 className="sticky top-0 z-10" style={{ background: 'var(--surface-2)' }}>
              <button
                type="button"
                data-turn-header
                aria-expanded={expanded}
                aria-controls={panel}
                onClick={() => toggle(group.promptId)}
                onKeyDown={onHeaderKey}
                title={group.prompt}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors duration-200 hover:bg-[var(--surface-1)]"
              >
                <span
                  className="shrink-0 text-[var(--text-muted)] transition-transform duration-[120ms]"
                  style={{ transform: expanded ? 'none' : 'rotate(-90deg)' }}
                >
                  <Icon name="disclose" size={12} />
                </span>
                <span className="tabular shrink-0 text-[11px] text-[var(--text-muted)]">
                  {formatWhen(group.startedAt)}
                </span>
                {group.prompt || group.instruction?.detail ? (
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--text-primary)]">
                    {group.prompt ? (
                      `“${group.prompt}”`
                    ) : (
                      <InstructionPreview text={group.instruction!.detail!} />
                    )}
                  </span>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-muted)]">
                    {group.origin === 'agent'
                      ? t('turn.fromAgent')
                      : group.origin === 'delegation'
                        ? t('turn.fromDelegation')
                        : group.origin === 'system'
                          ? t('turn.fromSystem')
                          : t('turn.noPrompt')}
                  </span>
                )}
                {ongoing && liveStatus ? (
                  <span className="activity-group-status flex shrink-0 items-center gap-2">
                    <StateBadge status={liveStatus} />
                    {liveStatus.waitingOn && (
                      <span className="max-w-[16rem] truncate text-[11px] text-[var(--text-secondary)]">
                        {waitingText(liveStatus.waitingOn, t)}
                      </span>
                    )}
                    <span className="tabular text-[11px] text-[var(--text-muted)]">
                      {t('latest.for', { d: formatSpan(Date.now() - Date.parse(group.startedAt)) })}
                    </span>
                  </span>
                ) : (
                  <span className="tabular flex shrink-0 items-center gap-2.5 text-[11px] text-[var(--text-muted)]">
                    <span>
                      {group.steps.length === 1
                        ? t('turn.stepsOne')
                        : t('turn.steps', { n: group.steps.length })}
                    </span>
                    {group.failed > 0 && (
                      <span
                        className="flex items-center gap-1"
                        style={{ color: 'var(--status-critical)' }}
                      >
                        <Icon name="cross" size={11} />
                        {t('detail.toolsFailed', { count: group.failed })}
                      </span>
                    )}
                    <span>
                      {formatSpan(Date.parse(group.endedAt) - Date.parse(group.startedAt))}
                    </span>
                  </span>
                )}
              </button>
            </h3>
            {expanded && (
              <ol id={panel} className="px-1.5 pb-1.5">
                {group.instruction &&
                  !group.steps.some(
                    (step) => step.kind === 'instruction' && step.id === group.instruction?.id,
                  ) && <InstructionRow step={group.instruction} nameOf={nameOf} context />}
                {group.steps.map((step) => (
                  <Row
                    key={`${step.id}-${step.kind}-${step.title}`}
                    step={step}
                    showAgent={showAgent}
                    colorOf={colorOf}
                    nameOf={nameOf}
                    fresh={fresh.has(step.id)}
                  />
                ))}
              </ol>
            )}
          </section>
        );
      })}
    </div>
  );
};

const Row = ({
  step,
  showAgent,
  colorOf,
  nameOf,
  fresh,
}: {
  step: Step;
  showAgent: boolean;
  colorOf?: ((agentId: string) => string) | undefined;
  nameOf?: ((agentId: string) => string | undefined) | undefined;
  fresh: boolean;
}) => {
  const { t } = useI18n();
  if (step.kind === 'instruction') return <InstructionRow step={step} nameOf={nameOf} />;
  if (step.kind === 'agent' && step.verb === 'returned')
    return (
      <ReturnedRow
        step={step}
        showAgent={showAgent}
        colorOf={colorOf}
        nameOf={nameOf}
        fresh={fresh}
      />
    );
  const isTool = step.kind === 'tool';
  const described = isTool ? describeTool(step.title, step.detail) : undefined;
  const error = step.kind === 'error' ? errorWording(step, t, Date.now()) : undefined;
  const icon = described
    ? CATEGORY_ICON[described.category]
    : step.kind === 'error'
      ? ERROR_META[step.errorKind ?? 'api']
      : NON_TOOL_ICON[step.kind as Exclude<StepKind, 'tool'>];
  // Plumbing stays in the record but recedes, so it never competes with work.
  const recessive = isTool && isPlumbing(step.title) && step.status !== 'failed';

  // An agent row whose title is the agent's own type would just repeat the agent
  // column. Say what happened instead, and let the name be the argument.
  const isPrompt = step.kind === 'prompt';
  // The agent talking. No label: "said:" in front of a sentence is furniture,
  // and the sentence is the only thing on the row worth reading.
  const isSaid = step.kind === 'said';
  // What a person typed is quoted, never labelled "prompt:" — so a one-character
  // prompt reads as a character someone typed, not as a glitch. A subagent's
  // first entry is the brief its parent wrote, and says so.
  const label = step.verb
    ? t(step.verb === 'spawned' ? 'activity.spawned' : 'activity.returned')
    : error
      ? error.label
      : isPrompt
        ? step.agentId === 'main'
          ? ''
          : t('activity.brief')
        : isSaid
          ? ''
          : step.title;
  const primary = step.verb
    ? step.title
    : error
      ? (error.primary ?? '')
      : isPrompt
        ? `“${step.detail ?? ''}”`
        : described
          ? described.primary
          : (step.detail ?? '');
  const secondary = step.verb ? step.detail : described?.secondary;

  return (
    <li
      className={`activity-row grid grid-cols-[auto_auto_auto_minmax(0,1fr)_auto] gap-x-2.5 rounded px-2 py-[5px] text-[12px] transition-colors hover:bg-[var(--surface-1)] ${isSaid ? 'items-start' : 'items-baseline'} ${fresh ? 'motion-safe:arrive' : ''}`}
      style={{ opacity: recessive ? 0.55 : 1 }}
    >
      <span className="tabular text-[10px] text-[var(--text-muted)]">{formatClock(step.ts)}</span>

      {/* Still, even while running: the one thing on the board that moves on
          its own is a project waiting on you. */}
      <span
        className="flex w-3.5 justify-center self-center"
        style={{
          color:
            described && step.status !== 'failed' && step.status !== 'limited'
              ? CATEGORY_COLOR[described.category]
              : step.kind === 'skill' && step.status !== 'failed' && step.status !== 'limited'
                ? 'var(--agent-5)'
                : STATUS_COLOR[step.status],
        }}
      >
        <Icon name={icon} size={13} />
      </span>

      {showAgent ? (
        <span
          className="activity-agent max-w-[9rem] truncate text-[10px]"
          style={{ color: colorOf?.(step.agentId) ?? 'var(--text-muted)' }}
        >
          {nameOf?.(step.agentId) ??
            (step.agentId === 'main'
              ? t('card.session')
              : (step.agentType ?? step.agentId.slice(0, 8)))}
        </span>
      ) : (
        <span />
      )}

      <span className="activity-message flex min-w-0 items-baseline gap-2">
        {label && (
          <span
            className="shrink-0 font-semibold"
            style={{
              color:
                step.status === 'failed' || step.status === 'limited'
                  ? STATUS_COLOR[step.status]
                  : 'var(--text-primary)',
            }}
            title={step.errorKind === 'parse' ? t('error.parseTitle') : undefined}
          >
            {label}
          </span>
        )}
        {primary && (
          <span
            className={
              isSaid
                ? // Two lines, wrapped: a sentence cut at one line is a sentence
                  // you have to open the card to finish.
                  'line-clamp-2 min-w-0 text-[var(--text-primary)]'
                : `min-w-0 truncate text-[var(--text-secondary)] ${!step.verb && described?.mono ? 'font-mono text-[11px]' : ''}`
            }
            title={step.detail}
            // Claude Code's own message, left in its language and marked as such
            // so a Portuguese screen reader pronounces it correctly.
            {...(error?.foreign ? { lang: 'en' } : {})}
          >
            {primary}
          </span>
        )}
        {secondary && (
          <span className="hidden min-w-0 shrink truncate text-[10px] text-[var(--text-muted)] lg:inline">
            {secondary}
          </span>
        )}
      </span>

      <span className="tabular text-[10px] text-[var(--text-muted)]">
        {formatElapsed(step.durationMs)}
      </span>
    </li>
  );
};

const InstructionRow = ({
  step,
  nameOf,
  context = false,
}: {
  step: Step;
  nameOf?: ((agentId: string) => string | undefined) | undefined;
  context?: boolean;
}) => {
  const { t } = useI18n();
  const name = (id: string | undefined, fallback: string) =>
    id ? (nameOf?.(id) ?? (id === 'main' ? t('card.mainSession') : id)) : fallback;
  const instruction = step.instruction;
  const sender = name(instruction?.senderAgentId, t('instruction.unknownSender'));
  const recipient =
    instruction?.instructionType === 'broadcast'
      ? t('instruction.team')
      : name(instruction?.recipientAgentId, t('instruction.unknownRecipient'));
  return (
    <li className="min-w-0 px-2 py-2 text-[12px]">
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--text-secondary)]">
        <span className="tabular text-[10px] text-[var(--text-muted)]">{formatClock(step.ts)}</span>
        <Icon name="handoff" size={13} className="text-[var(--accent)]" />
        <span className="font-medium text-[var(--text-primary)] [overflow-wrap:anywhere]">
          {t(context ? 'instruction.contextRoute' : 'instruction.route', { sender, recipient })}
        </span>
      </div>
      <InstructionText
        text={step.detail}
        availability={instruction?.availability}
        charCount={instruction?.charCount}
        truncated={instruction?.truncated}
      />
    </li>
  );
};

/** Returned text is evidence from the finish event, not a reconstructed reply. */
const ReturnedRow = ({
  step,
  showAgent,
  colorOf,
  nameOf,
  fresh,
}: {
  step: Step;
  showAgent: boolean;
  colorOf?: (agentId: string) => string;
  nameOf?: (agentId: string) => string | undefined;
  fresh: boolean;
}) => {
  const { t } = useI18n();
  const text =
    step.result?.availability !== 'encrypted' && step.detail?.trim() ? step.detail : undefined;
  const previewNote =
    step.result?.truncated === true
      ? t('activity.responseTruncated')
      : step.result?.truncated === undefined
        ? t('activity.responsePreview')
        : undefined;
  const long = Boolean(text && (text.length > 280 || text.split('\n').length > 4));
  const name =
    nameOf?.(step.agentId) ??
    (step.agentId === 'main' ? t('card.mainSession') : (step.agentType ?? step.title));
  return (
    <li
      className={`min-w-0 rounded px-2 py-2 text-[12px] hover:bg-[var(--surface-1)] ${fresh ? 'motion-safe:arrive' : ''}`}
    >
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="tabular text-[10px] text-[var(--text-muted)]">{formatClock(step.ts)}</span>
        <span className="self-center" style={{ color: STATUS_COLOR[step.status] }}>
          <Icon name={step.returnOutcome === 'interrupted' ? 'pause' : 'handoff'} size={13} />
        </span>
        <span
          className="font-semibold"
          style={{
            color:
              step.status === 'failed' || step.status === 'limited'
                ? STATUS_COLOR[step.status]
                : 'var(--text-primary)',
          }}
        >
          {t('activity.returned')}
        </span>
        <span
          className="min-w-0 text-[11px] [overflow-wrap:anywhere]"
          style={{
            color: showAgent
              ? (colorOf?.(step.agentId) ?? 'var(--text-secondary)')
              : 'var(--text-secondary)',
          }}
        >
          {name}
        </span>
        {step.returnOutcome === 'interrupted' && (
          <span className="text-[11px] text-[var(--status-serious)]">{t('state.interrupted')}</span>
        )}
        {step.returnOutcome === 'error' && (
          <span className="text-[11px] text-[var(--status-critical)]">{t('state.error')}</span>
        )}
        <span className="tabular ml-auto text-[10px] text-[var(--text-muted)]">
          {formatElapsed(step.durationMs)}
        </span>
      </div>
      {!text ? (
        <p className="py-1 text-[11px] text-[var(--text-secondary)]">
          {t(
            step.result?.availability === 'encrypted'
              ? 'activity.responseEncrypted'
              : 'activity.responseMissing',
          )}
        </p>
      ) : (
        <>
          {long ? (
            <details className="group min-w-0">
              <summary className="pressable min-h-11 cursor-pointer list-none rounded py-2 text-[var(--text-primary)] [&::-webkit-details-marker]:hidden">
                <span className="line-clamp-2 whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere] group-open:hidden">
                  {text}
                </span>
                <span className="flex items-center gap-1 py-1 text-[11px] text-[var(--accent)]">
                  <Icon name="disclose" size={12} />
                  <span className="group-open:hidden">{t('activity.readResponse')}</span>
                  <span className="hidden group-open:inline">{t('activity.closeResponse')}</span>
                </span>
              </summary>
              <div
                role="region"
                aria-label={t('activity.response')}
                tabIndex={0}
                className="max-h-[min(55vh,36rem)] max-w-[75ch] overflow-y-auto rounded pr-2 outline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              >
                <blockquote className="whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--text-primary)] [overflow-wrap:anywhere]">
                  {text}
                </blockquote>
              </div>
              {previewNote && (
                <p className="mt-2 text-[10px] leading-relaxed text-[var(--text-secondary)]">
                  {previewNote}
                </p>
              )}
            </details>
          ) : (
            <>
              <p className="max-w-[75ch] whitespace-pre-wrap leading-relaxed text-[var(--text-primary)] [overflow-wrap:anywhere]">
                {text}
              </p>
              {previewNote && (
                <p className="mt-1 text-[10px] leading-relaxed text-[var(--text-secondary)]">
                  {previewNote}
                </p>
              )}
            </>
          )}
        </>
      )}
    </li>
  );
};
