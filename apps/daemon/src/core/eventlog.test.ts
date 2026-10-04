import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type DraftEvent, type MiranteEvent } from '@mirante/shared';
import { EventLog } from './eventlog.js';
import { createDaemon } from '../server/index.js';
import { loadConfig } from '../config.js';

const dirs: string[] = [];
const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirante-log-'));
  dirs.push(dir);
  return join(dir, 'mirante.db');
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const draft = (overrides: Partial<DraftEvent> = {}): DraftEvent =>
  ({
    ts: '2026-09-20T12:00:00.000Z',
    source: 'transcript',
    sessionId: 'sess-1',
    projectPath: '/home/user/project',
    agentId: MAIN_AGENT_ID,
    kind: 'skill.invoked',
    payload: { skillName: 'review' },
    ...overrides,
  }) as DraftEvent;

describe('the event log', () => {
  it('assigns strictly increasing ids', () => {
    const log = new EventLog(workspace());
    const events = log.appendMany([draft(), draft(), draft()]);
    expect(events.map((e) => e.id)).toEqual([1, 2, 3]);
    log.close();
  });

  it('replays everything after a given id', () => {
    const log = new EventLog(workspace());
    log.appendMany([draft(), draft(), draft()]);
    expect(log.since(1).map((e) => e.id)).toEqual([2, 3]);
    log.close();
  });

  it('round-trips the turn a request belongs to', () => {
    const log = new EventLog(workspace());
    const [stored] = log.appendMany([draft({ promptId: 'prompt-7' })]);
    expect(stored?.promptId).toBe('prompt-7');
    expect(log.since(0)[0]?.promptId).toBe('prompt-7');
    log.close();
  });

  it('rebuilds current work beyond 100,000 events on restart and pages the API completely', async () => {
    const databasePath = workspace();
    const log = new EventLog(databasePath);
    log.appendMany(Array.from({ length: 100_000 }, () => draft()));
    const current = log.append(
      draft({
        kind: 'prompt.submitted',
        ts: new Date().toISOString(),
        payload: { preview: 'Current task', charCount: 12 },
      }),
    );
    expect(log.since(0)).toHaveLength(100_000);
    let last;
    for (const item of log.replay()) last = item;
    expect(last?.id).toBe(current.id);
    log.close();

    const token = 'd'.repeat(64);
    const instance = createDaemon({ config: loadConfig({ databasePath }), token, watch: false });
    try {
      expect(instance.projector.hasLiveWork('claude-code')).toBe(true);
      expect(instance.projector.snapshot().lastEventId).toBe(current.id);
      const auth = { authorization: `Bearer ${token}` };
      const first = (
        await instance.app.inject({ method: 'GET', url: '/api/events?since=0', headers: auth })
      ).json();
      expect(first.events).toHaveLength(10_000);
      expect(first.hasMore).toBe(true);
      const tail = (
        await instance.app.inject({ method: 'GET', url: '/api/events?since=100000', headers: auth })
      ).json();
      expect(tail.events.map((item: MiranteEvent) => item.id)).toEqual([current.id]);
      expect(tail.hasMore).toBe(false);
    } finally {
      await instance.close();
    }
  });

  it('upgrades a database written before a column existed', () => {
    // CREATE TABLE IF NOT EXISTS does nothing to an existing table, so without a
    // migration every insert would fail against a database from the last release.
    const path = workspace();
    const old = new Database(path);
    old.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, received_ts TEXT NOT NULL,
        source TEXT NOT NULL, session_id TEXT NOT NULL, project_path TEXT NOT NULL,
        git_branch TEXT, agent_id TEXT NOT NULL, agent_type TEXT, parent_agent_id TEXT,
        correlation_id TEXT, dedupe_key TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL
      );
    `);
    old.close();

    const log = new EventLog(path);
    expect(() => log.appendMany([draft({ promptId: 'prompt-1' })])).not.toThrow();
    expect(log.since(0)[0]?.promptId).toBe('prompt-1');
    log.close();
  });

  it('purges everything it stored', () => {
    const log = new EventLog(workspace());
    log.appendMany([draft(), draft()]);
    log.purge();
    expect(log.count()).toBe(0);
    log.close();
  });
});
