import { useEffect, useMemo, useState } from 'react';
import type { SessionLane } from '@mirante/shared';
import { useBoard, type Connection } from './lib/client';
import { useI18n } from './lib/i18n';
import { LatestRequest } from './components/LatestRequest';
import { PlanHint } from './components/PlanHint';
import { SessionDetail } from './components/SessionDetail';
import { SessionLaneView } from './components/SessionLane';
import { Timeline } from './components/Timeline';
import { TopBar } from './components/TopBar';

/** Sessions grouped by project, because that is how the work is organised. */
const groupByProject = (sessions: SessionLane[]): [string, SessionLane[]][] => {
  const groups = new Map<string, SessionLane[]>();
  for (const session of sessions) {
    const key = session.projectPath || session.projectName;
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }
  return [...groups.entries()].sort((a, b) => {
    const latest = (lanes: SessionLane[]) =>
      lanes.reduce((max, lane) => (lane.startedAt > max ? lane.startedAt : max), '');
    return latest(b[1]).localeCompare(latest(a[1]));
  });
};

export const App = () => {
  const { board, events, definitions, connection, decide } = useBoard();
  const { t } = useI18n();
  const [project, setProject] = useState('all');
  const [hideFinished, setHideFinished] = useState(false);
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

  const groups = useMemo(() => groupByProject(board.sessions), [board.sessions]);
  const visible = useMemo(
    () =>
      groups
        .filter(([path]) => project === 'all' || path === project)
        .map(
          ([path, lanes]) =>
            [path, hideFinished ? lanes.filter((l) => !l.endedAt) : lanes] as const,
        )
        .filter(([, lanes]) => lanes.length > 0),
    [groups, project, hideFinished],
  );

  const onDecide = (requestId: string, behavior: 'allow' | 'deny') => {
    void decide(requestId, behavior);
  };

  const openLane = board.sessions.find((session) => session.sessionId === openSessionId);

  return (
    <div className="mx-auto flex h-full max-w-[1800px] flex-col gap-3 p-3">
      <TopBar board={board} connection={connection} />

      {openLane ? (
        <SessionDetail
          lane={openLane}
          events={events}
          approvals={board.pendingApprovals}
          onDecide={onDecide}
          definitions={definitions}
          onClose={() => setOpenSessionId(undefined)}
        />
      ) : (
        <>
          <PlanHint board={board} />
          <LatestRequest events={events} sessions={board.sessions} onOpen={setOpenSessionId} />

          {/* Filters sit in one row above the board, never inside it. */}
          <div className="flex flex-wrap items-center gap-3 px-1">
            <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
              {t('filter.project')}
              <select
                value={project}
                onChange={(event) => setProject(event.target.value)}
                className="rounded border px-2 py-1 text-[11px]"
                style={{
                  background: 'var(--surface-1)',
                  borderColor: 'var(--hairline)',
                  color: 'var(--text-primary)',
                }}
              >
                <option value="all">{t('filter.allProjects')}</option>
                {groups.map(([path, lanes]) => (
                  <option key={path} value={path}>
                    {lanes[0]?.projectName ?? path}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={hideFinished}
                onChange={(event) => setHideFinished(event.target.checked)}
              />
              {t('filter.hideFinished')}
            </label>
          </div>

          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[1fr_340px]">
            <main className="min-h-0 space-y-4 overflow-y-auto pr-1">
              {visible.length === 0 && <EmptyState connection={connection} />}
              {visible.map(([path, lanes]) => (
                <section key={path}>
                  <h2 className="mb-2 px-1 text-[11px] font-medium text-[var(--text-muted)]">
                    {lanes[0]?.projectName ?? path}
                    <span className="ml-2">
                      {lanes.length} {t('stat.sessions').toLowerCase()}
                    </span>
                  </h2>
                  <div className="space-y-3">
                    {lanes.map((lane) => (
                      <SessionLaneView
                        key={lane.sessionId}
                        lane={lane}
                        approvals={board.pendingApprovals}
                        onDecide={onDecide}
                        definitions={definitions}
                        onOpen={() => setOpenSessionId(lane.sessionId)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </main>

            <Timeline entries={board.timeline} sessionFilter={undefined} />
          </div>
        </>
      )}
    </div>
  );
};

const EmptyState = ({ connection }: { connection: Connection }) => {
  const { t } = useI18n();
  const denied = connection === 'unauthorized';
  return (
    <div
      className="rounded-xl border p-8 text-center"
      style={{ background: 'var(--surface-2)', borderColor: 'var(--hairline)' }}
    >
      <p className="text-[13px] text-[var(--text-primary)]">
        {t(denied ? 'empty.unauthorized.title' : 'empty.title')}
      </p>
      <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
        {t(denied ? 'empty.unauthorized.body' : 'empty.body')}
      </p>
    </div>
  );
};
