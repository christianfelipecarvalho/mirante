import {
  addTokenUsage,
  emptyTokenUsage,
  type AgentCard,
  type Harness,
  type SessionLane,
  type TokenUsage,
  type WaitingOn,
} from '@mirante/shared';
import { bucketOf } from './buckets.js';
import { livenessOf } from './liveness.js';

/** The harnesses in the order the board names them. */
export const HARNESSES: readonly Harness[] = ['claude-code', 'codex'];

/** Something a person has to answer, and where it is. */
export type Awaited = {
  lane: SessionLane;
  card: AgentCard;
  waitingOn: WaitingOn;
};

/**
 * What a project card says in numbers.
 *
 * Every figure answers "right now": agents counted as running are the ones
 * heard from recently (lib/liveness), not the ones whose last word was
 * "working" hours ago, and a skill is in use only while an agent using it runs.
 */
export type ProjectSummary = {
  /** Agents working and heard from recently. */
  running: number;
  /** Agents not finished: running, waiting, resting, failed or silent. */
  open: number;
  failed: number;
  /** Agents that claim to work but have gone quiet. Never counted as running. */
  silent: number;
  /** Skills in use by running agents, most used first, with how many agents use each. */
  skills: { name: string; agents: number }[];
  /** Open sessions per harness, in `HARNESSES` order; harnesses with none are left out. */
  sessions: { harness: Harness; count: number }[];
  endedSessions: number;
  /** What has waited longest on a person, if anything does. */
  awaited?: Awaited;
  /** Everything waiting on a person, `awaited` included. */
  awaitingCount: number;
  /** What stopped the project at a plan limit, when that is its state. */
  limit?: Awaited;
  tokens: TokenUsage;
};

const NEEDS_PERSON = new Set(['waiting_approval', 'waiting_input']);

const oldest = (items: Awaited[]): Awaited | undefined =>
  [...items].sort((a, b) => a.waitingOn.since.localeCompare(b.waitingOn.since))[0];

export const summarizeProject = (lanes: readonly SessionLane[], now: number): ProjectSummary => {
  let running = 0;
  let open = 0;
  let failed = 0;
  let silent = 0;
  let tokens = emptyTokenUsage();
  const skillUse = new Map<string, number>();
  const perHarness = new Map<Harness, number>();
  const awaiting: Awaited[] = [];
  const limited: Awaited[] = [];

  for (const lane of lanes) {
    tokens = addTokenUsage(tokens, lane.tokens);
    const ended = Boolean(lane.endedAt);
    if (!ended) perHarness.set(lane.harness, (perHarness.get(lane.harness) ?? 0) + 1);

    for (const card of lane.cards) {
      const bucket = bucketOf(card, now, ended);
      if (bucket !== 'finished') open += 1;
      if (bucket === 'failed') failed += 1;
      if (bucket === 'no_signal') silent += 1;
      if (livenessOf(card, now, ended) === 'live') {
        running += 1;
        if (card.activeSkill)
          skillUse.set(card.activeSkill, (skillUse.get(card.activeSkill) ?? 0) + 1);
      }
      if (ended) continue;
      const on = card.status.waitingOn;
      if (on && NEEDS_PERSON.has(card.status.state)) awaiting.push({ lane, card, waitingOn: on });
      if (on && card.status.state === 'rate_limited') limited.push({ lane, card, waitingOn: on });
    }
  }

  const awaited = oldest(awaiting);
  const limit = oldest(limited);
  return {
    running,
    open,
    failed,
    silent,
    skills: [...skillUse.entries()]
      .map(([name, agents]) => ({ name, agents }))
      .sort((a, b) => b.agents - a.agents || a.name.localeCompare(b.name)),
    sessions: HARNESSES.filter((harness) => perHarness.has(harness)).map((harness) => ({
      harness,
      count: perHarness.get(harness) ?? 0,
    })),
    endedSessions: lanes.filter((lane) => lane.endedAt).length,
    ...(awaited ? { awaited } : {}),
    awaitingCount: awaiting.length,
    ...(limit ? { limit } : {}),
    tokens,
  };
};

/** The board in one line: how much is running, where, and what needs a person. */
export type BoardSummary = {
  running: number;
  /** Projects with at least one agent running. */
  projectsRunning: number;
  /** Distinct skills in use by running agents, board-wide. */
  skills: number;
  awaiting: number;
  /** Open sessions per harness, in `HARNESSES` order, including those with none open. */
  harnesses: { harness: Harness; sessions: number }[];
};

export const summarizeBoard = (projects: readonly SessionLane[][], now: number): BoardSummary => {
  const summaries = projects.map((lanes) => summarizeProject(lanes, now));
  const skills = new Set(summaries.flatMap((s) => s.skills.map((skill) => skill.name)));
  return {
    running: summaries.reduce((sum, s) => sum + s.running, 0),
    projectsRunning: summaries.filter((s) => s.running > 0).length,
    skills: skills.size,
    awaiting: summaries.reduce((sum, s) => sum + s.awaitingCount, 0),
    harnesses: HARNESSES.map((harness) => ({
      harness,
      sessions: summaries.reduce(
        (sum, s) => sum + (s.sessions.find((entry) => entry.harness === harness)?.count ?? 0),
        0,
      ),
    })),
  };
};
