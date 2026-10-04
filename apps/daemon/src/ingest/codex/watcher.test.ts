import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardProjector, type MiranteEvent } from '@mirante/shared';
import { EventLog } from '../../core/eventlog.js';
import { CodexWatcher, locateRollouts } from './watcher.js';

const FIXTURE = join(__dirname, '../../../../../tests/fixtures/codex-fanout');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A `$CODEX_HOME` laid out the way Codex lays it out, holding the recorded session. */
const codexHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'mirante-codex-'));
  dirs.push(home);
  const day = join(home, 'sessions', '2026', '09', '18');
  mkdirSync(day, { recursive: true });
  const names = {
    'root.jsonl': 'rollout-2026-09-18T10-11-41-01a0b4a4-e6d8-76f2-aad9-a3383586f8a3.jsonl',
    'subagent-1.jsonl': 'rollout-2026-09-18T11-10-09-01a0b4da-719b-72b3-b5c6-ec480fe56c59.jsonl',
    'subagent-2.jsonl': 'rollout-2026-09-18T11-10-15-01a0b4da-888c-7b92-ad50-cd8ade74d925.jsonl',
    'subagent-3.jsonl': 'rollout-2026-09-18T11-10-20-01a0b4da-9a7b-77f2-9e52-f145ddc5e2cb.jsonl',
  };
  for (const [fixture, name] of Object.entries(names))
    copyFileSync(join(FIXTURE, fixture), join(day, name));
  // Beside the sessions, as on a real machine. Never to be opened.
  writeFileSync(join(home, 'auth.json'), '{"tokens":"must never be read"}');
  writeFileSync(join(day, 'notes.txt'), 'not a rollout');
  return { home, sessionsDir: join(home, 'sessions'), day, names };
};

const setup = (sessionsDir: string, readBudgetBytes?: number) => {
  const dbDir = mkdtempSync(join(tmpdir(), 'mirante-codex-db-'));
  dirs.push(dbDir);
  const log = new EventLog(join(dbDir, 'mirante.db'));
  const received: MiranteEvent[] = [];
  const watcher = new CodexWatcher({
    sessionsDir,
    log,
    onEvents: (events) => received.push(...events),
    maxAgeMs: Number.POSITIVE_INFINITY,
    ...(readBudgetBytes ? { readBudgetBytes } : {}),
  });
  return { log, watcher, received, dbDir };
};

describe('finding rollout files', () => {
  it('lists only rollout files, root before the subagents it spawned', () => {
    const { sessionsDir, names } = codexHome();
    const found = locateRollouts(sessionsDir).map((path) => path.split('/').at(-1));
    expect(found).toEqual(Object.values(names));
  });
});

describe('the Codex watcher', () => {
  it('reads a session whole in one pass, as one Codex lane', () => {
    const { sessionsDir } = codexHome();
    const { watcher, received } = setup(sessionsDir);
    expect(watcher.scan()).toBeGreaterThan(0);
    const board = new BoardProjector();
    board.applyAll(received);
    const lanes = board.snapshot().sessions;
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.harness).toBe('codex');
    expect(lanes[0]?.cards).toHaveLength(4);
  });

  it('reads the same events when a small budget spreads the reading over many passes', () => {
    const { sessionsDir } = codexHome();
    const whole = setup(sessionsDir);
    whole.watcher.scan();

    const slow = setup(sessionsDir, 4096);
    for (let pass = 0; pass < 500 && slow.watcher.scan() >= 0; pass += 1) {
      if (slow.received.length === whole.received.length) break;
    }
    const strip = (events: MiranteEvent[]) =>
      events
        .map(({ id: _id, receivedTs: _r, ...rest }) => rest)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(strip(slow.received)).toEqual(strip(whole.received));
  });

  it('picks up what is appended, and only that', () => {
    const { sessionsDir, day, names } = codexHome();
    const { watcher, received } = setup(sessionsDir);
    watcher.scan();
    const before = received.length;
    expect(watcher.scan()).toBe(0);

    appendFileSync(
      join(day, names['root.jsonl']),
      JSON.stringify({
        timestamp: '2026-09-18T15:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Done with the review.' },
      }) + '\n',
    );
    expect(watcher.scan()).toBe(1);
    expect(received.slice(before).map((e) => e.kind)).toEqual(['agent.said']);
  });

  it('waits for a line to be finished before reading it', () => {
    const { sessionsDir, day, names } = codexHome();
    const { watcher, received } = setup(sessionsDir);
    watcher.scan();
    const before = received.length;
    const line = JSON.stringify({
      timestamp: '2026-09-18T15:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Olá — acentuação intacta.' },
    });
    const path = join(day, names['root.jsonl']);
    const bytes = Buffer.from(line + '\n', 'utf8');
    // Cut inside the multi-byte "á": half a character must not be decoded.
    const cut = bytes.indexOf(Buffer.from('á', 'utf8')) + 1;
    appendFileSync(path, bytes.subarray(0, cut));
    expect(watcher.scan()).toBe(0);
    appendFileSync(path, bytes.subarray(cut));
    expect(watcher.scan()).toBe(1);
    const said = received.slice(before)[0];
    expect(said?.kind === 'agent.said' && said.payload.text).toBe('Olá — acentuação intacta.');
  });

  it('appends nothing twice after a restart', () => {
    const { sessionsDir } = codexHome();
    const first = setup(sessionsDir);
    first.watcher.scan();
    const count = first.log.since(0).length;

    const again = new CodexWatcher({
      sessionsDir,
      log: first.log,
      onEvents: () => undefined,
      maxAgeMs: Number.POSITIVE_INFINITY,
    });
    again.reindexFromLog();
    expect(again.scan()).toBe(0);
    expect(first.log.since(0).length).toBe(count);
  });

  it('leaves old history alone', () => {
    const { sessionsDir, day, names } = codexHome();
    const old = Date.now() / 1000 - 3 * 24 * 60 * 60;
    for (const name of Object.values(names)) utimesSync(join(day, name), old, old);
    const dbDir = mkdtempSync(join(tmpdir(), 'mirante-codex-db-'));
    dirs.push(dbDir);
    const watcher = new CodexWatcher({
      sessionsDir,
      log: new EventLog(join(dbDir, 'mirante.db')),
      onEvents: () => undefined,
    });
    expect(watcher.scan()).toBe(0);
  });

  it('is silent when Codex is not installed', () => {
    const { watcher } = setup(join(tmpdir(), 'mirante-no-codex-here', 'sessions'));
    expect(watcher.scan()).toBe(0);
  });

  it('never reads the credential file beside the sessions', () => {
    const { home, sessionsDir } = codexHome();
    const { watcher, log } = setup(sessionsDir);
    watcher.scan();
    const stored = JSON.stringify(log.since(0));
    expect(stored).not.toContain('must never be read');
    // Still there, untouched.
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toContain('must never be read');
  });
});
