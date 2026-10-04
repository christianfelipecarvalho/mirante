import { useEffect, useMemo, useState } from 'react';
import type { Harness } from '@mirante/shared';
import { useArchive } from './lib/archive';
import { useBoard, type Connection } from './lib/client';
import { useI18n } from './lib/i18n';
import { useNow } from './lib/now';
import { summarizeBoard } from './lib/project-summary';
import { groupProjects, partitionStale } from './lib/projects';
import { BoardSkeleton } from './components/BoardSkeleton';
import { BoardSummary } from './components/BoardSummary';
import { BudgetAlerts } from './components/BudgetAlerts';
import { LatestRequest } from './components/LatestRequest';
import { ProjectBar } from './components/ProjectBar';
import { ProjectCard, QuietProjects } from './components/ProjectCard';
import { SessionDetail } from './components/SessionDetail';
import { Timeline } from './components/Timeline';
import { TopBar } from './components/TopBar';

export const App = () => {
  const { board, events, definitions, connection, decide, refreshPlanUsage } = useBoard();
  const { t } = useI18n();
  const { archived, archive, restoreAll } = useArchive();
  const now = useNow();
  const [project, setProject] = useState('all');
  // Both coding agents by default; either one on its own, from the summary line.
  const [harness, setHarness] = useState<Harness | 'all'>('all');
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
    else {
      url.searchParams.delete('session');
      // Agent and tab belong to a session detail. Leaving them behind makes a
      // different session reopen on an unrelated old tab instead of its live
      // topology.
      url.searchParams.delete('tab');
      url.searchParams.delete('agent');
    }
    window.history.replaceState({}, '', url);
  }, [openSessionId]);

  // Sessions silent for days are history. Hidden unless asked for, and back on
  // their own the moment they do anything. See lib/projects#partitionStale.
  const { current, stale } = useMemo(
    () => partitionStale(board.sessions, board.timeline, now),
    [board.sessions, board.timeline, now],
  );
  const inScope = hideOld ? current : board.sessions;
  // Every project, archived ones included: how many exist decides whether an
  // empty board means "nothing yet" or "all put away".
  const everyGroup = useMemo(
    () => groupProjects(inScope, board.timeline, now),
    [inScope, board.timeline, now],
  );
  // An archived project that starts waiting on a decision comes back. Archiving
  // hides noise; it must never hide a request for your approval.
  const unarchived = useMemo(
    () => everyGroup.filter((group) => !archived.has(group.key) || group.activity === 'needs_you'),
    [everyGroup, archived],
  );
  // The summary counts every harness, so it can offer the one not shown.
  const summary = useMemo(
    () =>
      summarizeBoard(
        unarchived.map((group) => group.lanes),
        now,
      ),
    [unarchived, now],
  );
  // A harness with nothing left on the board stops filtering it: an empty board
  // that looks like "nothing is running" would be a lie.
  const onlyHarness =
    harness !== 'all' &&
    summary.harnesses.some((entry) => entry.harness === harness && entry.sessions > 0)
      ? harness
      : 'all';
  // Filtered by lane, then grouped again: a project's state and order must
  // come from the sessions shown, not from ones the filter put away.
  const shown = useMemo(
    () =>
      onlyHarness === 'all'
        ? unarchived
        : groupProjects(
            inScope.filter((lane) => lane.harness === onlyHarness),
            board.timeline,
            now,
          ).filter((group) => !archived.has(group.key) || group.activity === 'needs_you'),
    [onlyHarness, unarchived, inScope, board.timeline, now, archived],
  );
  const visible = useMemo(
    () => shown.filter((group) => project === 'all' || group.key === project),
    [shown, project],
  );
  // What is alive gets a card; what has stopped becomes a row. One project
  // chosen on its own is always a card: it was chosen to be looked at.
  const full = visible.filter(
    (group) => project !== 'all' || (group.activity !== 'idle' && group.activity !== 'finished'),
  );
  const quiet = visible.filter((group) => !full.includes(group));
  const archiveProject = (key: string) => {
    archive(key);
    if (project === key) setProject('all');
  };

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
      <BudgetAlerts board={board} now={now} connection={connection} />

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
          <BoardSummary summary={summary} harness={onlyHarness} onHarness={setHarness} />

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
            {/* A filter, so a checkbox — never a button near "Restore", which
                undoes something the person did. Ended sessions need no filter
                of their own: each project folds them into one line. */}
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
            <main className="min-h-0 space-y-3 overflow-y-auto pr-1">
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
                ) : archived.size > 0 && everyGroup.length > 0 ? (
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

              {full.map((group) => (
                <ProjectCard
                  key={group.key}
                  group={group}
                  approvals={board.pendingApprovals}
                  onDecide={onDecide}
                  definitions={definitions}
                  onOpen={setOpenSessionId}
                  now={now}
                  onArchive={() => archiveProject(group.key)}
                />
              ))}

              <QuietProjects
                groups={quiet}
                approvals={board.pendingApprovals}
                onDecide={onDecide}
                definitions={definitions}
                onOpen={setOpenSessionId}
                now={now}
                onArchive={archiveProject}
              />
            </main>

            <Timeline entries={board.timeline} sessionFilter={undefined} />
          </div>
        </>
      )}
    </div>
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
