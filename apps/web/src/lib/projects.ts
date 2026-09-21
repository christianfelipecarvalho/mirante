import type { SessionLane, TimelineEntry } from '@mirante/shared';
import { livenessOf } from './liveness.js';

/**
 * What a project needs from you, in the order you need to know it.
 *
 * The board is glanced at, not read. Whatever is asking for a decision has to be
 * the first thing under the cursor, and whatever finished hours ago has to be
 * out of the way without being gone.
 */
export const PROJECT_ACTIVITIES = ['needs_you', 'working', 'blocked', 'idle', 'finished'] as const;
export type ProjectActivity = (typeof PROJECT_ACTIVITIES)[number];

const RANK: Record<ProjectActivity, number> = {
  needs_you: 0,
  working: 1,
  blocked: 2,
  idle: 3,
  finished: 4,
};

export type ProjectGroup = {
  /** Stable identity for the group. The path, or the name when there is no path. */
  key: string;
  name: string;
  lanes: SessionLane[];
  activity: ProjectActivity;
  /** ISO 8601. Most recent thing that happened anywhere in the project. */
  lastActivityAt: string;
  /** Sessions still open. Zero means the project is over for now, not archived. */
  liveSessions: number;
  /** Cards blocked on a person, counted so a chip can show the number. */
  awaiting: number;
  /** ISO 8601. When the newest session in the project opened. */
  latestStartAt: string;
};

/**
 * Within a tier, what decides the order.
 *
 * Busy projects are ordered by when their newest session opened, because that
 * changes rarely: ordered by last event, two working projects would trade places
 * on every tool call. Quiet ones are ordered by when they last did something,
 * which for them does not change at all — and puts the long-silent at the bottom.
 */
const tierKey = (group: ProjectGroup): string =>
  group.activity === 'working' || group.activity === 'needs_you'
    ? group.latestStartAt
    : group.lastActivityAt;

const activityOf = (lanes: SessionLane[], now: number): ProjectActivity => {
  const live = lanes.filter((lane) => !lane.endedAt);
  if (live.length === 0) return 'finished';

  const cards = live.flatMap((lane) => lane.cards);
  const states = cards.map((card) => card.status.state);
  if (states.some((state) => state === 'waiting_approval' || state === 'waiting_input')) {
    return 'needs_you';
  }
  // Working means heard from recently. A card still saying "thinking" from a
  // session abandoned weeks ago would otherwise hold its project at the top of
  // the board, above the one actually running. A parent waiting on a subagent
  // counts through the subagent's own card, which is in this list too.
  if (cards.some((card) => livenessOf(card, now) === 'live')) return 'working';
  if (states.includes('rate_limited')) return 'blocked';
  return 'idle';
};

const awaitingIn = (lanes: SessionLane[]): number =>
  lanes
    .filter((lane) => !lane.endedAt)
    .flatMap((lane) => lane.cards)
    .filter(
      (card) => card.status.state === 'waiting_approval' || card.status.state === 'waiting_input',
    ).length;

/**
 * When each session last did anything, from every clock the board has.
 *
 * A lane records when it started, never when it last moved; the timeline and
 * each card's last signal say that. Returns a function so the timeline is
 * indexed once and asked many times.
 */
export const lastActivityClock = (
  timeline: readonly TimelineEntry[],
): ((lane: SessionLane) => string) => {
  const lastBySession = new Map<string, string>();
  for (const entry of timeline) {
    const seen = lastBySession.get(entry.sessionId);
    if (seen === undefined || entry.ts > seen) lastBySession.set(entry.sessionId, entry.ts);
  }
  return (lane) =>
    [
      lastBySession.get(lane.sessionId),
      lane.endedAt,
      lane.startedAt,
      ...lane.cards.map((card) => card.lastEventAt),
    ]
      .filter((value): value is string => value !== undefined)
      .reduce((max, value) => (value > max ? value : max), '');
};

/**
 * After this long without a signal, a session is history, not work.
 *
 * Three days rather than one: a terminal left open over a weekend is still the
 * place you will pick up on Monday. Nothing is lost — a hidden session comes
 * back the moment it does something, and the board can show them on demand.
 */
export const STALE_SESSION_MS = 3 * 24 * 60 * 60 * 1000;

export const partitionStale = (
  sessions: SessionLane[],
  timeline: readonly TimelineEntry[],
  now: number,
  maxAgeMs: number = STALE_SESSION_MS,
): { current: SessionLane[]; stale: SessionLane[] } => {
  const lastOf = lastActivityClock(timeline);
  const current: SessionLane[] = [];
  const stale: SessionLane[] = [];
  for (const lane of sessions) {
    const last = Date.parse(lastOf(lane));
    // No exemption for a session "waiting on you": an approval expires in
    // minutes, so one still showing after three days was abandoned — and kept
    // visible it would pulse at the top of the board forever.
    if (Number.isFinite(last) && now - last > maxAgeMs) stale.push(lane);
    else current.push(lane);
  }
  return { current, stale };
};

/**
 * Groups sessions by project and sorts them the way they are looked at.
 *
 * Activity first, recency second. Two projects both working are ordered by which
 * one moved last, so the one you just typed into stays where you left it.
 *
 * `timeline` supplies the clock: a lane carries when it started, never when it
 * last did something, and sorting open sessions by start time puts a session
 * that has been silent all day above one that answered a second ago.
 */
export const groupProjects = (
  sessions: SessionLane[],
  timeline: readonly TimelineEntry[] = [],
  now: number = Date.now(),
): ProjectGroup[] => {
  const lastOf = lastActivityClock(timeline);

  const groups = new Map<string, SessionLane[]>();
  for (const session of sessions) {
    const key = session.projectPath || session.projectName;
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }

  return [...groups.entries()]
    .map(([key, lanes]): ProjectGroup => {
      const ordered = [...lanes].sort((a, b) => lastOf(b).localeCompare(lastOf(a)));
      return {
        key,
        name: ordered[0]?.projectName ?? key,
        lanes: ordered,
        activity: activityOf(ordered, now),
        lastActivityAt: ordered.map(lastOf).reduce((max, at) => (at > max ? at : max), ''),
        liveSessions: ordered.filter((lane) => !lane.endedAt).length,
        awaiting: awaitingIn(ordered),
        latestStartAt: ordered
          .map((lane) => lane.startedAt)
          .reduce((max, at) => (at > max ? at : max), ''),
      };
    })
    .sort((a, b) => RANK[a.activity] - RANK[b.activity] || tierKey(b).localeCompare(tierKey(a)));
};
