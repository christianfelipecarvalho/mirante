import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BoardProjector, MAIN_AGENT_ID, type DraftEvent, type MiranteEvent } from '@mirante/shared';
import { codexPlanUsage, createThreadState, parseRolloutLines } from './parse.js';

/**
 * Two recorded Codex sessions, one per history layout Codex writes:
 * `codex-fanout` (0.154, paginated: messages as `item_completed` items) and
 * `codex-legacy` (0.155, legacy: messages as `event_msg` records, subagents
 * that open by replaying their parent's history, a question, waits).
 */
const FIXTURES = join(__dirname, '../../../../../tests/fixtures');

const lines = (fixture: string, file: string): unknown[] =>
  readFileSync(join(FIXTURES, fixture, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);

const parse = (fixture: string, file: string) => {
  const state = createThreadState();
  const { events, warnings } = parseRolloutLines(state, lines(fixture, file));
  return { state, events, warnings };
};

const ofKind = <K extends DraftEvent['kind']>(events: DraftEvent[], kind: K) =>
  events.filter((event): event is Extract<DraftEvent, { kind: K }> => event.kind === kind);

const project = (events: DraftEvent[]) => {
  const projector = new BoardProjector();
  events.forEach((event, index) =>
    projector.apply({ ...event, id: index + 1, receivedTs: event.ts } as MiranteEvent),
  );
  return projector.snapshot(Date.parse('2026-09-30T00:00:00Z'));
};

describe('a Codex root thread', () => {
  const { events, warnings } = parse('codex-fanout', 'root.jsonl');

  it('opens a lane that says it is Codex, and which version', () => {
    const [start] = ofKind(events, 'session.started');
    expect(warnings).toEqual([]);
    expect(start?.payload).toMatchObject({
      harness: 'codex',
      harnessVersion: '0.154.0-alpha.6.2',
      entrypoint: 'vscode',
      cwd: '/home/user/project',
    });
    expect(start?.sessionId).toBe('01a0b4a4-e6d8-76f2-aad9-a3383586f8a3');
  });

  it('reads the prompts of the paginated layout, one per turn', () => {
    const prompts = ofKind(events, 'prompt.submitted');
    expect(prompts).toHaveLength(2);
    // The turn is the request: everything it caused is grouped under it.
    expect(prompts[0]?.payload.promptId).toBe('01a0b4a4-e828-78d2-a3df-04d31ddd12ff');
  });

  it('names its shell calls in the board vocabulary and closes every one', () => {
    const started = ofKind(events, 'tool.started');
    expect(started.length).toBeGreaterThan(0);
    // exec_command is a shell; view_image reads a file.
    expect(new Set(started.map((e) => e.payload.toolName))).toEqual(new Set(['Bash', 'Read']));
    expect(ofKind(events, 'tool.finished')).toHaveLength(started.length);
  });

  it('finds the skills it reads, once per turn', () => {
    expect(ofKind(events, 'skill.invoked').map((e) => e.payload.skillName)).toEqual([
      'skill-1',
      'skill-2',
    ]);
  });

  it('never shows a message between agents, which Codex encrypts', () => {
    expect(JSON.stringify(events)).not.toContain('gAAAA');
  });
});

describe('a Codex subagent thread', () => {
  const { state, events } = parse('codex-fanout', 'subagent-1.jsonl');

  it('knows its parent from its own first line, not by inference', () => {
    expect(state.sessionId).toBe('01a0b4a4-e6d8-76f2-aad9-a3383586f8a3');
    expect(state.parentAgentId).toBe(MAIN_AGENT_ID);
  });

  it('starts as an asynchronous agent named after its task', () => {
    const [start] = ofKind(events, 'agent.started');
    expect(start?.agentId).toBe('01a0b4da-719b-72b3-b5c6-ec480fe56c59');
    expect(start?.payload).toMatchObject({
      agentType: 'role-1',
      description: 'task 1',
      spawnMode: 'async',
    });
    expect(start?.payload.followUp).toBeUndefined();
  });

  it('hands back when its task completes', () => {
    const [finish] = ofKind(events, 'agent.finished');
    expect(finish?.payload).toMatchObject({ outcome: 'ok', handedBackTo: MAIN_AGENT_ID });
  });

  it('has no prompts: its instruction came from its parent', () => {
    expect(ofKind(events, 'prompt.submitted')).toEqual([]);
  });

  it('declares its session under the key the root uses, so only one is kept', () => {
    const [declared] = ofKind(events, 'session.started');
    const [root] = ofKind(parse('codex-fanout', 'root.jsonl').events, 'session.started');
    expect(declared?.dedupeKey).toBe(root?.dedupeKey);
    expect(declared?.payload.harness).toBe('codex');
  });

  it('reads effort from its own context, excluding the medium effort inherited from its parent', () => {
    const metadata = ofKind(events, 'agent.metadata.updated');
    expect(metadata.length).toBeGreaterThan(0);
    expect(metadata.every((event) => event.payload.effort === 'ultra')).toBe(true);
    expect(
      project(events).sessions[0]?.cards.find((card) => card.agentId === state.agentId)?.effort,
    ).toBe('ultra');
  });
});

describe('effort is explicitly reported rather than assumed', () => {
  it('clears an unavailable context setting instead of retaining the earlier effort', () => {
    const input = lines('codex-fanout', 'root.jsonl');
    const context = input.find((line) => (line as { type?: string }).type === 'turn_context') as {
      type: string;
      timestamp: string;
      payload: Record<string, unknown>;
    };
    const state = createThreadState();
    const first = parseRolloutLines(state, input);
    const payload = { ...context.payload };
    delete payload.effort;
    const later = parseRolloutLines(state, [
      { ...context, timestamp: '2026-09-30T00:00:00.000Z', payload },
    ]);
    expect(ofKind(later.events, 'agent.metadata.updated')[0]?.payload.effort).toBeNull();
    expect(
      project([...first.events, ...later.events]).sessions[0]?.cards.find(
        (card) => card.agentId === MAIN_AGENT_ID,
      )?.effort,
    ).toBeUndefined();
  });
});

describe('a subagent that opens by replaying its parent', () => {
  const { events } = parse('codex-legacy', 'subagent-1.jsonl');

  it('ignores the inherited history and begins at its own first turn', () => {
    // The replayed head holds the parent's session records and the person's
    // prompt. Read as the subagent's own, it would claim to have typed it.
    const work = events.filter((event) => event.kind !== 'session.started');
    expect(work[0]?.kind).toBe('agent.started');
    expect((work[0]?.ts ?? '') >= '2026-09-29T23:28:41').toBe(true);
    expect(ofKind(events, 'prompt.submitted')).toEqual([]);
  });

  it('reports each later assignment as a follow-up, under its own key', () => {
    const starts = ofKind(events, 'agent.started');
    expect(starts.length).toBeGreaterThan(1);
    expect(starts.slice(1).every((e) => e.payload.followUp === true)).toBe(true);
    expect(new Set(starts.map((e) => e.dedupeKey)).size).toBe(starts.length);
  });

  it('says what it waits on when it waits without children of its own', () => {
    const waits = ofKind(events, 'waiting.changed').filter(
      (e) => e.payload.status.state === 'waiting_subagent',
    );
    expect(waits.length).toBeGreaterThan(0);
    expect(waits[0]?.payload.status.waitingOn?.summary).toBe('Waiting on other agents');
  });
});

describe('a Codex root that spawns, waits and asks', () => {
  const { events } = parse('codex-legacy', 'root.jsonl');

  it('reads the prompts of the legacy layout', () => {
    expect(ofKind(events, 'prompt.submitted').length).toBeGreaterThan(0);
  });

  it('names the roles it spawned when it waits on them', () => {
    const waits = ofKind(events, 'waiting.changed').filter(
      (e) => e.payload.status.state === 'waiting_subagent',
    );
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.at(-1)?.payload.status.waitingOn?.subject).toMatch(/role-1|dba|architect/);
  });

  it('does not treat an asynchronous question as a wait: the agent keeps working', () => {
    expect(
      ofKind(events, 'waiting.changed').some((e) => e.payload.status.state === 'waiting_input'),
    ).toBe(false);
  });
});

describe('reading a thread in pieces', () => {
  it('produces the same events as reading it whole', () => {
    const all = lines('codex-legacy', 'subagent-1.jsonl');
    const whole = parseRolloutLines(createThreadState(), all).events;
    const state = createThreadState();
    const pieces: DraftEvent[] = [];
    for (let i = 0; i < all.length; i += 7) {
      pieces.push(...parseRolloutLines(state, all.slice(i, i + 7)).events);
    }
    expect(pieces).toEqual(whole);
  });
});

describe('what Codex does not show', () => {
  it('ignores a guardian thread, which reviews approvals rather than doing work', () => {
    const { events } = parseRolloutLines(createThreadState(), [
      {
        timestamp: '2026-09-29T10:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: '01a0f000-0000-7000-8000-000000000001',
          session_id: '01a0f000-0000-7000-8000-000000000000',
          cwd: '/p',
          source: { subagent: { other: 'guardian' } },
        },
      },
      {
        timestamp: '2026-09-29T10:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: '01a0f000-0000-7000-8000-000000000002' },
      },
    ]);
    expect(events).toEqual([]);
  });

  it('holds a synchronous question as a wait on the person, naming it, until it is answered', () => {
    const meta = {
      timestamp: '2026-09-29T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: '01a0f000-0000-7000-8000-00000000000a', cwd: '/p', source: 'cli' },
    };
    const turn = {
      timestamp: '2026-09-29T10:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: '01a0f000-0000-7000-8000-00000000000b' },
    };
    const ask = {
      timestamp: '2026-09-29T10:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'request_user_input',
        call_id: 'call_q',
        arguments: JSON.stringify({ questions: [{ title: 'Ship it on Friday?', options: [] }] }),
      },
    };
    const answer = {
      timestamp: '2026-09-29T10:05:00.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_q', output: 'yes' },
    };
    const { events } = parseRolloutLines(createThreadState(), [meta, turn, ask, answer]);
    const waits = ofKind(events, 'waiting.changed').map((e) => e.payload.status);
    expect(waits.at(-2)).toMatchObject({
      state: 'waiting_input',
      waitingOn: { reason: 'input', detail: 'Ship it on Friday?' },
    });
    expect(waits.at(-1)).toEqual({ state: 'thinking' });
    expect(ofKind(events, 'session.started')[0]?.payload.entrypoint).toBe('cli');
  });

  it('reports a failed script as a failed tool, with the line that says why', () => {
    const { events } = parseRolloutLines(createThreadState(), [
      {
        timestamp: '2026-09-29T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: '01a0f000-0000-7000-8000-00000000000c', cwd: '/p' },
      },
      {
        timestamp: '2026-09-29T10:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_x',
          input: 'text(await tools.exec_command({cmd:"pnpm test"}))',
        },
      },
      {
        timestamp: '2026-09-29T10:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_x',
          output: [
            { type: 'input_text', text: 'Script failed\nWall time 4 seconds\nTypeError: x' },
          ],
        },
      },
    ]);
    expect(ofKind(events, 'tool.started')[0]?.payload.summary).toBe('pnpm test');
    expect(ofKind(events, 'tool.failed')[0]?.payload.errorPreview).toBe('TypeError: x');
  });
});

describe('a whole Codex team on the board', () => {
  const events = ['root.jsonl', 'subagent-1.jsonl', 'subagent-2.jsonl', 'subagent-3.jsonl'].flatMap(
    (file) => parse('codex-fanout', file).events,
  );
  const state = project(events);

  it('folds every thread into one lane, harness Codex', () => {
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]?.harness).toBe('codex');
    expect(state.sessions[0]?.cards).toHaveLength(4);
  });

  it('leaves no child counted as running once every task completed', () => {
    const root = state.sessions[0]?.cards.find((card) => card.agentId === MAIN_AGENT_ID);
    expect(root?.runningChildren).toBe(0);
    expect(
      state.sessions[0]?.cards
        .filter((card) => card.agentId !== MAIN_AGENT_ID)
        .map((c) => c.status.state),
    ).toEqual(['done', 'done', 'done']);
  });
});

describe("Codex's own plan limits", () => {
  const { events } = parse('codex-fanout', 'root.jsonl');
  const readings = ofKind(events, 'plan.usage.updated');

  it('reads them from the usage reports, as Codex plan, not Claude Code', () => {
    expect(readings.length).toBeGreaterThan(0);
    expect(readings.every((e) => e.payload.harness === 'codex')).toBe(true);
    expect(readings[0]?.payload.planType).toBe('prolite');
    // The weekly window of this plan, reached that day.
    expect(readings.at(-1)?.payload.usage.sevenDay?.usedPercentage).toBe(100);
    expect(readings.at(-1)?.payload.usage.fiveHour).toBeUndefined();
  });

  it('reports changes immediately and limits unchanged readings to one per minute', () => {
    const counts = ofKind(events, 'usage.updated').length;
    expect(readings.length).toBeLessThan(counts);
    const serialised = readings.map((e) => JSON.stringify(e.payload));
    expect(
      serialised.every(
        (value, index) =>
          index === 0 ||
          value !== serialised[index - 1] ||
          Date.parse(readings[index]?.ts ?? '') - Date.parse(readings[index - 1]?.ts ?? '') >=
            60_000,
      ),
    ).toBe(true);
  });

  it('stops that session’s cards at the limit, and no one else’s', () => {
    // A moment when the week had not yet reset.
    const projector = new BoardProjector();
    events.forEach((event, index) =>
      projector.apply({ ...event, id: index + 1, receivedTs: event.ts } as MiranteEvent),
    );
    projector.apply({
      id: 10_000,
      ts: '2026-09-18T14:12:00.000Z',
      receivedTs: '2026-09-18T14:12:00.000Z',
      source: 'transcript',
      sessionId: 'claude-1',
      projectPath: '/w/other',
      agentId: MAIN_AGENT_ID,
      kind: 'prompt.submitted',
      payload: { preview: 'go', charCount: 2 },
    });
    const state = projector.snapshot(Date.parse('2026-09-18T14:12:00Z'));
    const codex = state.sessions.find((lane) => lane.harness === 'codex');
    const claude = state.sessions.find((lane) => lane.harness === 'claude-code');
    expect(state.harnessPlans?.codex?.usage.sevenDay?.usedPercentage).toBe(100);
    expect(state.planUsage).toBeUndefined();
    expect(codex?.cards.find((card) => card.agentId === MAIN_AGENT_ID)?.status).toMatchObject({
      state: 'rate_limited',
      waitingOn: { reason: 'plan_limit', subject: 'sevenDay' },
    });
    expect(claude?.cards[0]?.status.state).toBe('thinking');
  });
});

describe('fresh Codex plan readings with an unchanged percentage', () => {
  const meta = {
    timestamp: '2026-09-29T10:00:00.000Z',
    type: 'session_meta',
    payload: { id: '01a0f000-0000-7000-8000-00000000000a', cwd: '/p', source: 'cli' },
  };
  const usage = (timestamp: string, percentage = 90) => ({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: percentage, window_minutes: 300, resets_at: 1790694000 },
        plan_type: 'plus',
      },
    },
  });

  it('renews the source timestamp once per minute while suppressing intervening reports', () => {
    const { events } = parseRolloutLines(createThreadState(), [
      meta,
      usage('2026-09-29T10:00:01.000Z'),
      usage('2026-09-29T10:00:59.000Z'),
      usage('2026-09-29T10:01:00.999Z'),
      usage('2026-09-29T10:01:01.000Z'),
      usage('2026-09-29T10:01:59.000Z'),
      usage('2026-09-29T10:02:01.000Z'),
    ]);
    const readings = ofKind(events, 'plan.usage.updated');
    expect(readings.map((event) => event.ts)).toEqual([
      '2026-09-29T10:00:01.000Z',
      '2026-09-29T10:01:01.000Z',
      '2026-09-29T10:02:01.000Z',
    ]);
    expect(project(events).harnessPlans?.codex?.updatedAt).toBe('2026-09-29T10:02:01.000Z');
  });

  it('publishes a changed percentage immediately and starts the heartbeat from that reading', () => {
    const { events } = parseRolloutLines(createThreadState(), [
      meta,
      usage('2026-09-29T10:00:01.000Z'),
      usage('2026-09-29T10:00:20.000Z', 91),
      usage('2026-09-29T10:01:01.000Z', 91),
      usage('2026-09-29T10:01:20.000Z', 91),
    ]);
    const readings = ofKind(events, 'plan.usage.updated');
    expect(readings.map((event) => event.payload.usage.fiveHour?.usedPercentage)).toEqual([
      90, 91, 91,
    ]);
    expect(readings.at(-1)?.ts).toBe('2026-09-29T10:01:20.000Z');
  });

  it('does not use old or invalid source timestamps to renew freshness', () => {
    const { events } = parseRolloutLines(createThreadState(), [
      meta,
      usage('2026-09-29T10:00:01.000Z'),
      usage('2026-09-29T10:01:01.000Z'),
      usage('2026-09-29T10:00:01.000Z'),
      usage('invalid'),
      usage('2026-09-29T10:01:59.000Z'),
    ]);
    expect(ofKind(events, 'plan.usage.updated').map((event) => event.ts)).toEqual([
      '2026-09-29T10:00:01.000Z',
      '2026-09-29T10:01:01.000Z',
    ]);
  });

  it('replays the same heartbeat events regardless of batch boundaries or the wall clock', () => {
    const records = [
      meta,
      usage('2026-09-29T10:00:01.000Z'),
      usage('2026-09-29T10:00:40.000Z'),
      usage('2026-09-29T10:01:01.000Z'),
      usage('2026-09-29T10:01:20.000Z', 92),
      usage('2026-09-29T10:02:20.000Z', 92),
    ];
    const whole = parseRolloutLines(createThreadState(), records).events;
    const state = createThreadState();
    const batches = records.flatMap((record) => parseRolloutLines(state, [record]).events);
    expect(batches).toEqual(whole);
    expect(parseRolloutLines(createThreadState(), records).events).toEqual(whole);
  });
});

describe('Codex plan windows', () => {
  it('are named by their size, and a size never seen is left out', () => {
    expect(
      codexPlanUsage({
        primary: { used_percent: 12, window_minutes: 300, resets_at: 1790000000 },
        secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1790500000 },
      }),
    ).toEqual({
      fiveHour: { usedPercentage: 12, resetsAt: 1790000000 },
      sevenDay: { usedPercentage: 40, resetsAt: 1790500000 },
    });
    expect(codexPlanUsage({ primary: { used_percent: 5, window_minutes: 60 } })).toBeUndefined();
    expect(codexPlanUsage(null)).toBeUndefined();
  });
});
