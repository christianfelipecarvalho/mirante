import type { AgentCard } from '@mirante/shared';
import { livenessOf } from './liveness.js';

/**
 * What an agent is, from the reader's side of the screen.
 *
 * A lane that draws thirteen agents in spawn order gives the two that are
 * working the same area as the ten that are history, and the board's only
 * hierarchy device — light — inverts: the lit card becomes the exception in a
 * field of dark ones. Rank is the fix, and it is the same rank the project row
 * already uses one level up (see lib/projects.ts), so the two levels of the
 * board agree about what comes first.
 */
export type AgentBucket = 'needs_you' | 'working' | 'failed' | 'stopped' | 'no_signal' | 'finished';

export const BUCKET_ORDER: readonly AgentBucket[] = [
  'needs_you',
  'working',
  'failed',
  'stopped',
  'no_signal',
  'finished',
];

const rank = (bucket: AgentBucket): number => BUCKET_ORDER.indexOf(bucket);

export const bucketOf = (card: AgentCard, now: number, sessionEnded = false): AgentBucket => {
  const state = card.status.state;
  if (state === 'waiting_approval' || state === 'waiting_input') return 'needs_you';
  // A plan limit stopped it; nothing broke. It keeps a card, because the work
  // can be run again the moment the window reopens.
  if (state === 'rate_limited' || (state === 'error' && card.stoppedAtLimit)) return 'stopped';
  if (state === 'error') return 'failed';
  if (state === 'done' || card.endedAt !== undefined) return 'finished';
  // A session that closed took its agents with it, whatever they last claimed.
  if (sessionEnded) return 'finished';
  // Claims to be working, has not been heard from in half an hour. This is not
  // a state the agent reported — it is the board declining to repeat a claim it
  // can no longer support. See lib/liveness.
  if (livenessOf(card, now, sessionEnded) === 'silent') return 'no_signal';
  return 'working';
};

/** When a card last gave any sign of life, for ordering the past. */
const lastSignal = (card: AgentCard): number =>
  Date.parse(card.endedAt ?? card.lastEventAt ?? card.startedAt);

/**
 * The lane's order: what needs a person, then what runs, then what broke, then
 * the past.
 *
 * Inside `working`, oldest first. The agent that has been going longest is the
 * one most likely stuck, and a newly spawned agent appends to the row instead
 * of pushing everything else sideways while the person is reading it.
 */
export const orderAgents = (
  cards: readonly AgentCard[],
  now: number,
  sessionEnded = false,
): AgentCard[] =>
  [...cards].sort((a, b) => {
    const byBucket = rank(bucketOf(a, now, sessionEnded)) - rank(bucketOf(b, now, sessionEnded));
    if (byBucket !== 0) return byBucket;
    const aWorking = bucketOf(a, now, sessionEnded) === 'working';
    return aWorking
      ? Date.parse(a.startedAt) - Date.parse(b.startedAt)
      : lastSignal(b) - lastSignal(a);
  });

export type AgentGroups = {
  /** Drawn as cards: still someone's problem. */
  open: AgentCard[];
  /** Drawn as one summary row each, in this order. */
  closed: { bucket: 'no_signal' | 'finished'; cards: AgentCard[] }[];
  counts: Record<AgentBucket, number>;
};

/**
 * Splits a lane's agents into what still deserves a card and what has become a
 * line in a ledger.
 *
 * Only two buckets fold. A failure stays a card however old it is — an error
 * among thirteen agents is the one thing a person must not miss — and a card
 * stopped at a limit stays too, because it is work waiting to resume.
 */
export const groupAgents = (
  cards: readonly AgentCard[],
  now: number,
  sessionEnded = false,
): AgentGroups => {
  const ordered = orderAgents(cards, now, sessionEnded);
  const counts: Record<AgentBucket, number> = {
    needs_you: 0,
    working: 0,
    failed: 0,
    stopped: 0,
    no_signal: 0,
    finished: 0,
  };
  const open: AgentCard[] = [];
  const noSignal: AgentCard[] = [];
  const finished: AgentCard[] = [];

  for (const card of ordered) {
    const bucket = bucketOf(card, now, sessionEnded);
    counts[bucket] += 1;
    if (bucket === 'no_signal') noSignal.push(card);
    else if (bucket === 'finished') finished.push(card);
    else open.push(card);
  }

  const closed: AgentGroups['closed'] = [];
  if (noSignal.length > 0) closed.push({ bucket: 'no_signal', cards: noSignal });
  if (finished.length > 0) closed.push({ bucket: 'finished', cards: finished });
  return { open, closed, counts };
};
