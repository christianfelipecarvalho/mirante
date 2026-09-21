import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import { useArchive } from './lib/archive';
import { useBoard, type Connection } from './lib/client';
import { useI18n } from './lib/i18n';
import { useNow } from './lib/now';
import {
  groupProjects,
  partitionStale,
  type ProjectActivity,
  type ProjectGroup,
} from './lib/projects';
import { BoardSkeleton } from './components/BoardSkeleton';
import { Icon, type IconName } from './components/Icon';
import { LatestRequest } from './components/LatestRequest';
import { ProjectBar } from './components/ProjectBar';
import { SessionDetail } from './components/SessionDetail';
import { SessionLaneView } from './components/SessionLane';
import { Timeline } from './components/Timeline';
import { TopBar } from './components/TopBar';

const STATE_ICON: Record<ProjectActivity, IconName> = {
  needs_you: 'alert',
  working: 'play',
  blocked: 'pause',
  idle: 'dot',
  finished: 'check',
};

const STATE_COLOR: Record<ProjectActivity, string> = {
  needs_you: 'var(--status-warning)',
  working: 'var(--accent)',
  blocked: 'var(--status-serious)',
  idle: 'var(--text-muted)',
  finished: 'var(--text-muted)',
};

export const App = () => {
  const { board, events, definitions, connection, decide, refreshPlanUsage } = useBoard();
  const { t } = useI18n();
  const { archived, archive, restoreAll } = useArchive();
  const now = useNow();
  const [project, setProject] = useState('all');
  const [hideFinished, setHideFinished] = useState(false);
  // Checked on every load, never remembered: old sessions are the exception.
  const [hideOld, setHideOld] = useState(true);
  // The open session lives in the URL, so a particular session can be bookmarked
  // and reopened, and a reload does not throw you back to the board.
  const [openSessionId, setOpenSessionId] = useState<string | undefined>(
    () => new URLSearchParams(window.location.search).get('session') ?? undefined,
  );

  useEffect(() => {
    const url = new URL(window.location.href);
    if (openSessionId) url.searchParams.set('session', openSessionId);
    else url.searchParams.delete('session');
    window.history.replaceState({}, '', url);
  }, [openSessionId]);

  // Sessions silent for days are history. Hidden unless asked for, and back on
  // their own the moment they do anything. See lib/projects#partitionStale.
  const { current, stale } = useMemo(
    () => partitionStale(board.sessions, board.timeline, now),
    [board.sessions, board.timeline, now],
  );
  const groups = useMemo(
    () => groupProjects(hideOld ? current : board.sessions, board.timeline, now),
    [hideOld, board.sessions, current, board.timeline, now],
  );
  // An archived project that starts waiting on a decision comes back. Archiving
  // hides noise; it must never hide a request for your approval.
  const shown = useMemo(
    () => groups.filter((group) => !archived.has(group.key) || group.activity === 'needs_you'),
    [groups, archived],
  );
  const visible = useMemo(
    () =>
      shown
        .filter((group) => project === 'all' || group.key === project)
        .map((group) =>
          hideFinished ? { ...group, lanes: group.lanes.filter((l) => !l.endedAt) } : group,
        )
        .filter((group) => group.lanes.length > 0),
    [shown, project, hideFinished],
  );

  // The latest request follows the project filter and the archive, like the
  // board below it: selecting a project and seeing another one's request on top
  // would contradict the control just used.
  const inView = useMemo(() => {
    const sessions = new Set(visible.flatMap((group) => group.lanes.map((l) => l.sessionId)));
    return {
      events: events.filter((event) => sessions.has(event.sessionId)),
      sessions: board.sessions.filter((session) => sessions.has(session.sessionId)),
    };
  }, [visible, events, board.sessions]);

  const onDecide = (requestId: string, behavior: 'allow' | 'deny') => {
    void decide(requestId, behavior);
  };

  const openLane = board.sessions.find((session) => session.sessionId === openSessionId);

  return (
    <div className="mx-auto flex h-full max-w-[1800px] flex-col gap-3 p-3">
      <TopBar board={board} connection={connection} onRefreshPlanUsage={refreshPlanUsage} />

      {openLane ? (
        <SessionDetail
          key={openLane.sessionId}
          lane={openLane}
          events={events}
          approvals={board.pendingApprovals}
          onDecide={onDecide}
          definitions={definitions}
          onClose={() => setOpenSessionId(undefined)}
        />
      ) : (
        <>
          {/* Controls sit in one row above what they control, never inside it. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1">
              <ProjectBar
                groups={shown}
                selected={project}
                onSelect={setProject}
                archivedCount={archived.size}
                onRestoreAll={restoreAll}
              />
            </div>
            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[11px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                className="cursor-pointer"
                checked={hideFinished}
                onChange={(event) => setHideFinished(event.target.checked)}
              />
              {t('filter.hideFinished')}
            </label>
            {/* A filter, so a checkbox beside its sibling — never a button near
                "Restore", which undoes something the person did. */}
            <label
              className="flex shrink-0 cursor-pointer items-center gap-2 text-[11px] text-[var(--text-secondary)]"
              title={t('filter.hideOldTitle')}
            >
              <input
                type="checkbox"
                className="cursor-pointer"
                checked={hideOld}
                onChange={(event) => setHideOld(event.target.checked)}
              />
              {stale.length > 0
                ? t('filter.hideOldCount', { n: stale.length })
                : t('filter.hideOld')}
            </label>
          </div>

          <LatestRequest
            events={inView.events}
            sessions={inView.sessions}
            now={now}
            onOpen={setOpenSessionId}
          />

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
            <main className="min-h-0 space-y-5 overflow-y-auto pr-1">
              {/* Loading, nothing yet, and everything put away are three different
                  answers. Only one of them is bad news. */}
              {visible.length === 0 &&
                (connection === 'connecting' ? (
                  <BoardSkeleton />
                ) : hideOld && stale.length > 0 && current.length === 0 ? (
                  // Everything is old. "No sessions yet" would be false.
                  <Notice
                    title={t('old.emptyTitle')}
                    body={t('old.emptyBody', { n: stale.length })}
                    action={{ label: t('old.show'), onClick: () => setHideOld(false) }}
                  />
                ) : archived.size > 0 && groups.length > 0 ? (
                  <Notice
                    title={t('project.allArchived')}
                    body={t('project.allArchivedBody')}
                    action={{
                      label:
                        archived.size === 1
                          ? t('project.restoreOne')
                          : t('project.restoreAll', { n: archived.size }),
                      onClick: restoreAll,
                    }}
                  />
                ) : (
                  <EmptyState connection={connection} />
                ))}

              {visible.map((group) => (
                <ProjectSection
                  key={group.key}
                  group={group}
                  approvals={board.pendingApprovals}
                  onDecide={onDecide}
                  definitions={definitions}
                  onOpen={setOpenSessionId}
                  now={now}
                  onArchive={() => {
                    archive(group.key);
                    if (project === group.key) setProject('all');
                  }}
                />
              ))}
            </main>

            <Timeline entries={board.timeline} sessionFilter={undefined} />
          </div>
        </>
      )}
    </div>
  );
};

const ProjectSection = ({
  group,
  approvals,
  onDecide,
  definitions,
  onOpen,
  onArchive,
  now,
}: {
  group: ProjectGroup;
  approvals: ComponentProps<typeof SessionLaneView>['approvals'];
  onDecide: (requestId: string, behavior: 'allow' | 'deny') => void;
  definitions: ComponentProps<typeof SessionLaneView>['definitions'];
  onOpen: (sessionId: string) => void;
  onArchive: () => void;
  now: number;
}) => {
  const { t } = useI18n();

  return (
    <section className="group/project">
      <header className="mb-2 flex items-center gap-2 px-1">
        <span aria-hidden="true" style={{ color: STATE_COLOR[group.activity] }}>
          <Icon name={STATE_ICON[group.activity]} size={13} />
        </span>
        <h2 className="text-[15px] font-semibold tracking-tight text-[var(--text-primary)]">
          {group.name}
        </h2>
        <span className="text-[11px]" style={{ color: STATE_COLOR[group.activity] }}>
          {t(`project.state.${group.activity}` as 'project.state.idle')}
        </span>
        <span className="tabular text-[11px] text-[var(--text-muted)]">
          {group.lanes.length === 1
            ? t('project.sessions.one')
            : t('project.sessions', { n: group.lanes.length })}
        </span>

        {/* Revealed on hover, but always reachable by keyboard: a control that
            only exists on hover does not exist for a keyboard. */}
        <button
          type="button"
          onClick={onArchive}
          title={t('project.archiveTitle')}
          className="pressable ml-auto flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px] opacity-0 transition-opacity duration-200 group-hover/project:opacity-100 focus-visible:opacity-100"
          style={{ color: 'var(--text-muted)' }}
        >
          <Icon name="archive" size={12} />
          {t('project.archive')}
        </button>
      </header>

      <div className="space-y-3">
        {group.lanes.map((lane) => (
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
        ))}
      </div>
    </section>
  );
};

const Notice = ({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}) => (
  <div
    className="rounded-xl border p-8 text-center"
    style={{ background: 'var(--surface-2)', borderColor: 'var(--hairline)' }}
  >
    <p className="text-[13px] text-[var(--text-primary)]">{title}</p>
    <p className="mt-1 text-[12px] text-[var(--text-secondary)]">{body}</p>
    {action && (
      <button
        type="button"
        onClick={action.onClick}
        className="pressable mt-3 cursor-pointer rounded-md border px-3 py-1.5 text-[11px] transition-colors duration-200"
        style={{ borderColor: 'var(--hairline)', color: 'var(--text-secondary)' }}
      >
        {action.label}
      </button>
    )}
  </div>
);

const EmptyState = ({ connection }: { connection: Connection }) => {
  const { t } = useI18n();
  const denied = connection === 'unauthorized';
  return (
    <Notice
      title={t(denied ? 'empty.unauthorized.title' : 'empty.title')}
      body={t(denied ? 'empty.unauthorized.body' : 'empty.body')}
    />
  );
};
