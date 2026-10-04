import { useId, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import type { SessionLane } from '@mirante/shared';
import { describeAgent } from '../lib/agents';
import { formatDuration, formatTokens } from '../lib/format';
import { useI18n, type Translate } from '../lib/i18n';
import { PROJECT_MARK } from '../lib/project-state';
import { summarizeProject, type Awaited, type ProjectSummary } from '../lib/project-summary';
import type { ProjectGroup } from '../lib/projects';
import { agentAnchor, waitingText } from './AgentCard';
import { Icon } from './Icon';
import { SessionLaneView } from './SessionLane';

type LaneProps = ComponentProps<typeof SessionLaneView>;

export type ProjectCardProps = {
  group: ProjectGroup;
  approvals: LaneProps['approvals'];
  onDecide: LaneProps['onDecide'];
  definitions: LaneProps['definitions'];
  onOpen: (sessionId: string) => void;
  onArchive: () => void;
  now: number;
};

/** How many skill names fit on the line before the rest fold behind "+N". */
const SKILLS_SHOWN = 3;

/**
 * One project, as one box.
 *
 * The board used to draw the project as a bare heading over boxed sessions over
 * boxed agents, so the level people scan by was the one level without an edge.
 * Now the project is the box, its sessions are sections inside it, and the
 * agents keep their cards: two levels of box instead of three.
 *
 * It answers, top to bottom, in the order the questions are asked: what is
 * this and is it alive; what does it need from me; how much is running right
 * now — agents, skills, sessions and in which harness; and then the detail.
 */
export const ProjectCard = ({
  group,
  approvals,
  onDecide,
  definitions,
  onOpen,
  onArchive,
  now,
}: ProjectCardProps) => {
  const { t } = useI18n();
  const summary = summarizeProject(group.lanes, now);
  const mark = PROJECT_MARK[group.activity];
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const lanesId = useId();
  const titleId = useId();
  const openLanes = group.lanes.filter((lane) => !lane.endedAt);
  const endedLanes = group.lanes.filter((lane) => lane.endedAt);
  const lanesFor = (lanes: SessionLane[]) =>
    lanes.map((lane) => (
      <SessionLaneView
        key={lane.sessionId}
        lane={lane}
        approvals={approvals}
        onDecide={onDecide}
        definitions={definitions}
        onOpen={() => onOpen(lane.sessionId)}
        inProject
        now={now}
      />
    ));

  // "Go to request" has to find the card, and the card is inside the sessions.
  const goTo = (awaited: Awaited) => {
    setSessionsOpen(true);
    requestAnimationFrame(() => {
      const target = document.getElementById(
        agentAnchor(awaited.lane.sessionId, awaited.card.agentId),
      );
      if (!target) return;
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
      // The decision is the reason to go there: land on it.
      (target.querySelector('button') ?? target).focus({ preventScroll: true });
    });
  };

  return (
    <section
      aria-labelledby={titleId}
      className="glow-card glow-quiet group/project relative rounded-xl border p-4"
      data-life={
        group.activity === 'needs_you' ? 'waiting' : summary.running > 0 ? 'working' : 'rest'
      }
      style={{ '--card-surface': 'var(--surface-2)', '--glow': 'var(--accent)' } as CSSProperties}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span aria-hidden="true" style={{ color: mark.color }}>
          <Icon name={mark.icon} size={13} />
        </span>
        <h2
          id={titleId}
          className="text-[15px] font-semibold tracking-tight text-[var(--text-primary)]"
        >
          {group.name}
        </h2>
        <span className="text-[12px]" style={{ color: mark.color }}>
          {t(`project.state.${group.activity}` as 'project.state.idle')}
        </span>
        <span className="tabular ml-auto text-[11px] text-[var(--text-muted)]">
          {t('project.activeAgo', {
            d: formatDuration(group.lastActivityAt, new Date(now).toISOString()),
          })}
        </span>
        {/* Revealed on hover, always reachable by keyboard, and always shown
            where there is no hover at all. */}
        <button
          type="button"
          onClick={onArchive}
          title={t('project.archiveTitle')}
          className="pressable hover-reveal flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px] opacity-0 transition-opacity duration-200 group-hover/project:opacity-100 focus-visible:opacity-100"
          style={{ color: 'var(--text-muted)' }}
        >
          <Icon name="archive" size={12} />
          {t('project.archive')}
        </button>
      </header>

      {summary.awaited ? (
        <AwaitedRow
          awaited={summary.awaited}
          more={summary.awaitingCount - 1}
          now={now}
          onGo={() => summary.awaited && goTo(summary.awaited)}
        />
      ) : (
        group.activity === 'blocked' &&
        summary.limit && <LimitRow awaited={summary.limit} now={now} />
      )}

      <div className="mt-3 flex flex-col gap-1.5">
        <AgentsLine summary={summary} />
        <SkillsLine summary={summary} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            aria-expanded={sessionsOpen}
            aria-controls={lanesId}
            onClick={() => setSessionsOpen((open) => !open)}
            className="flex cursor-pointer items-center gap-2 text-[13px] text-[var(--text-secondary)] transition-colors duration-200 hover:text-[var(--text-primary)]"
          >
            <span
              aria-hidden="true"
              className="transition-transform duration-150"
              style={{ transform: sessionsOpen ? 'none' : 'rotate(-90deg)' }}
            >
              <Icon name="disclose" size={12} />
            </span>
            <Icon name="harness" size={13} />
            <Emphasis text={sessionsText(summary, t)} />
          </button>
          <span className="tabular ml-auto text-[11px] text-[var(--text-muted)]">
            {formatTokens(summary.tokens)} {t('card.tokens')}
          </span>
        </div>
      </div>

      {sessionsOpen && openLanes.length > 0 && (
        <div
          id={lanesId}
          className="panel-enter mt-2 divide-y divide-[var(--hairline)] border-t border-[var(--hairline)]"
        >
          {lanesFor(openLanes)}
        </div>
      )}
      {sessionsOpen && endedLanes.length > 0 && (
        <EndedSessions count={endedLanes.length}>{lanesFor(endedLanes)}</EndedSessions>
      )}
    </section>
  );
};

/**
 * A number set in the sentence that carries it: the figure at weight and in
 * the primary colour, the words around it quieter. The sentence stays whole
 * for a screen reader and for translation — only its first number is lifted.
 */
const Emphasis = ({ text }: { text: string }) => {
  const match = /\d[\d.,]*/.exec(text);
  if (!match) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, match.index)}
      <span className="tabular font-semibold text-[var(--text-primary)]">{match[0]}</span>
      {text.slice(match.index + match[0].length)}
    </span>
  );
};

const Line = ({ icon, children }: { icon: 'agents' | 'skill'; children: ReactNode }) => (
  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[var(--text-secondary)]">
    <span aria-hidden="true" className="flex w-3 justify-center text-[var(--text-muted)]">
      <Icon name={icon} size={13} />
    </span>
    {children}
  </div>
);

/**
 * Agents running now, and what the rest are doing. A silent agent and a failed
 * one are named apart and never folded into the running count: one is a gap
 * in what Mirante knows, the other the thing a person must not miss.
 */
const AgentsLine = ({ summary }: { summary: ProjectSummary }) => {
  const { t } = useI18n();
  const running =
    summary.running === 0
      ? t('project.running.none')
      : summary.running === 1
        ? t('project.running.one')
        : t('project.running', { n: summary.running });
  return (
    <Line icon="agents">
      <Emphasis text={running} />
      {summary.open > summary.running && (
        <span className="tabular text-[12px] text-[var(--text-muted)]">
          {t('project.open', { n: summary.open })}
        </span>
      )}
      {summary.failed > 0 && (
        <span
          className="flex items-center gap-1 text-[12px]"
          style={{ color: 'var(--status-critical)' }}
        >
          <Icon name="cross" size={11} />
          {summary.failed === 1
            ? t('project.failed.one')
            : t('project.failed', { n: summary.failed })}
        </span>
      )}
      {summary.silent > 0 && (
        <span className="flex items-center gap-1 text-[12px] text-[var(--text-muted)]">
          <Icon name="unknown" size={11} />
          {summary.silent === 1
            ? t('group.noSignalOne')
            : t('group.noSignal', { n: summary.silent })}
        </span>
      )}
    </Line>
  );
};

const SkillsLine = ({ summary }: { summary: ProjectSummary }) => {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const count = summary.skills.length;
  const shown = all ? summary.skills : summary.skills.slice(0, SKILLS_SHOWN);
  const hidden = count - shown.length;
  return (
    <Line icon="skill">
      <Emphasis
        text={
          count === 0
            ? t('project.skills.none')
            : count === 1
              ? t('project.skills.one')
              : t('project.skills', { n: count })
        }
      />
      {shown.map((skill, index) => (
        <span
          key={skill.name}
          title={
            skill.agents === 1
              ? t('project.skillAgents.one')
              : t('project.skillAgents', { n: skill.agents })
          }
          // Two names on a phone, three where there is room.
          className={`${index === SKILLS_SHOWN - 1 && !all ? 'hidden md:inline-block' : 'inline-block'} max-w-[22ch] truncate rounded px-1.5 py-0.5 text-[11px]`}
          style={{ background: 'var(--surface-1)', color: 'var(--text-secondary)' }}
        >
          {skill.name}
        </span>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          aria-expanded={all}
          aria-label={t('project.moreSkillsLabel', { n: hidden })}
          onClick={() => setAll(true)}
          className="pressable cursor-pointer rounded px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors duration-200 hover:text-[var(--text-primary)]"
          style={{ background: 'var(--surface-1)' }}
        >
          {t('project.moreSkills', { n: hidden })}
        </button>
      )}
    </Line>
  );
};

const sessionsText = (summary: ProjectSummary, t: Translate): string => {
  const total = summary.sessions.reduce((sum, entry) => sum + entry.count, 0);
  const [only] = summary.sessions;
  if (total === 0 || !only) return t('project.noOpenSessions');
  if (summary.sessions.length === 1) {
    const h = t(`harness.${only.harness}`);
    return only.count === 1
      ? t('project.sessionsIn.one', { h })
      : t('project.sessionsIn', { n: only.count, h });
  }
  return t('project.sessionsMixed', {
    n: total,
    list: summary.sessions
      .map((entry) => `${entry.count} ${t(`harness.${entry.harness}`)}`)
      .join(', '),
  });
};

/**
 * What the project needs from the person, on the project itself. The chip
 * above says a project is waiting; this says on what, from whom, for how long —
 * and leads to the card where it can be answered.
 */
const AwaitedRow = ({
  awaited,
  more,
  now,
  onGo,
}: {
  awaited: Awaited;
  more: number;
  now: number;
  onGo: () => void;
}) => {
  const { t } = useI18n();
  return (
    <div
      className="mt-3 flex flex-wrap items-start gap-x-3 gap-y-2 rounded border-l-2 px-3 py-2"
      style={{ borderColor: 'var(--status-warning)', background: 'var(--surface-1)' }}
    >
      <span className="mt-0.5" style={{ color: 'var(--status-warning)' }} aria-hidden="true">
        <Icon name="alert" size={13} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-[13px] text-[var(--text-primary)]">
          {waitingText(awaited.waitingOn, t)}
        </p>
        <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
          {t('project.waitingWhere', {
            agent: describeAgent(awaited.card, t).name,
            where: awaited.lane.gitBranch ?? t(`harness.${awaited.lane.harness}`),
            d: formatDuration(awaited.waitingOn.since, new Date(now).toISOString()),
          })}
          {more > 0 && (
            <span className="ml-2 font-medium" style={{ color: 'var(--status-warning)' }}>
              {more === 1 ? t('project.moreWaiting.one') : t('project.moreWaiting', { n: more })}
            </span>
          )}
        </p>
      </div>
      <button
        type="button"
        onClick={onGo}
        className="pressable shrink-0 cursor-pointer rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors duration-200"
        style={{ borderColor: 'var(--status-warning)', color: 'var(--text-primary)' }}
      >
        {t('project.goToRequest')}
      </button>
    </div>
  );
};

/** A project stopped at a plan limit says which, and since when. */
const LimitRow = ({ awaited, now }: { awaited: Awaited; now: number }) => {
  const { t } = useI18n();
  return (
    <div
      className="mt-3 flex items-start gap-3 rounded border-l-2 px-3 py-2"
      style={{ borderColor: 'var(--status-serious)', background: 'var(--surface-1)' }}
    >
      <span className="mt-0.5" style={{ color: 'var(--status-serious)' }} aria-hidden="true">
        <Icon name="pause" size={13} />
      </span>
      <p className="text-[13px] text-[var(--text-primary)]">
        {waitingText(awaited.waitingOn, t)}
        <span className="ml-2 text-[11px] text-[var(--text-secondary)]">
          {t('waiting.for', {
            duration: formatDuration(awaited.waitingOn.since, new Date(now).toISOString()),
          })}
        </span>
      </p>
    </div>
  );
};

/** Sessions that ended, as one line that opens, like finished agents in a lane. */
const EndedSessions = ({ count, children }: { count: number; children: ReactNode }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="mt-2 rounded-md px-2 py-1.5" style={{ background: 'var(--surface-1)' }}>
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
        <Icon name="check" size={12} />
        {count === 1 ? t('project.ended.one') : t('project.ended', { n: count })}
        <span className="font-normal text-[var(--text-muted)]">
          {open ? t('group.putAway') : t('group.show')}
        </span>
      </button>
      {open && (
        <div id={id} className="panel-enter divide-y divide-[var(--hairline)]">
          {children}
        </div>
      )}
    </div>
  );
};

/**
 * Projects with nothing running, as one list of rows.
 *
 * A finished project drawn at full size competes with the one that is working.
 * Each row still says what state it is in, which harness it ran in, and
 * anything that failed or went silent — the two things that must not fold
 * away — and opens into the full card in place.
 */
export const QuietProjects = ({
  groups,
  ...card
}: Omit<ProjectCardProps, 'group' | 'onArchive'> & {
  groups: ProjectGroup[];
  onArchive: (key: string) => void;
}) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  if (groups.length === 0) return null;
  const toggle = (key: string) =>
    setExpanded((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <ul
      aria-label={t('project.quietList')}
      className="divide-y divide-[var(--hairline)] overflow-hidden rounded-lg border border-[var(--hairline)]"
      style={{ background: 'var(--surface-1)' }}
    >
      {groups.map((group) => {
        const open = expanded.has(group.key);
        const summary = summarizeProject(group.lanes, card.now);
        const mark = PROJECT_MARK[group.activity];
        const harnesses =
          summary.sessions.length > 0 ? summary.sessions : lanesByHarness(group.lanes);
        return (
          <li key={group.key}>
            <button
              type="button"
              aria-expanded={open}
              title={t('project.expand')}
              onClick={() => toggle(group.key)}
              className="flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-[12px] transition-colors duration-200 hover:bg-[var(--surface-2)]"
            >
              <span aria-hidden="true" style={{ color: mark.color }}>
                <Icon name={mark.icon} size={12} />
              </span>
              <span className="font-medium text-[var(--text-primary)]">{group.name}</span>
              <span style={{ color: mark.color }}>
                {t(`project.state.${group.activity}` as 'project.state.idle')}
              </span>
              <span className="flex items-center gap-1 text-[var(--text-secondary)]">
                <Icon name="harness" size={11} />
                {harnesses.map((entry) => t(`harness.${entry.harness}`)).join(', ')}
              </span>
              {summary.failed > 0 && (
                <span
                  className="flex items-center gap-1"
                  style={{ color: 'var(--status-critical)' }}
                >
                  <Icon name="cross" size={11} />
                  {summary.failed === 1
                    ? t('project.failed.one')
                    : t('project.failed', { n: summary.failed })}
                </span>
              )}
              {summary.silent > 0 && (
                <span className="flex items-center gap-1 text-[var(--text-muted)]">
                  <Icon name="unknown" size={11} />
                  {summary.silent === 1
                    ? t('group.noSignalOne')
                    : t('group.noSignal', { n: summary.silent })}
                </span>
              )}
              <span className="tabular ml-auto text-[11px] text-[var(--text-muted)]">
                {t('project.activeAgo', {
                  d: formatDuration(group.lastActivityAt, new Date(card.now).toISOString()),
                })}
              </span>
              <span
                aria-hidden="true"
                className="text-[var(--text-muted)] transition-transform duration-150"
                style={{ transform: open ? 'none' : 'rotate(-90deg)' }}
              >
                <Icon name="disclose" size={12} />
              </span>
            </button>
            {open && (
              <div className="panel-enter p-2">
                <ProjectCard group={group} {...card} onArchive={() => card.onArchive(group.key)} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
};

/** Harnesses a project ran in, when none of its sessions is still open. */
const lanesByHarness = (lanes: readonly SessionLane[]) =>
  [...new Set(lanes.map((lane) => lane.harness))].map((harness) => ({ harness }));
