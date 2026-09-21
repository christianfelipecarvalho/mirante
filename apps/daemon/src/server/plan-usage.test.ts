import type * as ChildProcess from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import type { PlanReading } from '../ingest/plan-usage.js';
import { createDaemon, type Daemon } from './index.js';

// Watched, not replaced: every real call still goes through.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

const TOKEN = 'a'.repeat(64);
const config = loadConfig({ databasePath: ':memory:', port: 7788, approvalWindowMs: 150 });
const auth = { authorization: `Bearer ${TOKEN}` };

let daemon: Daemon | undefined;
const makeDaemon = (readPlanUsage: () => Promise<PlanReading>): Daemon => {
  daemon = createDaemon({ config, token: TOKEN, watch: false, readPlanUsage });
  return daemon;
};

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

const reading: PlanReading = {
  ok: true,
  usage: { fiveHour: { usedPercentage: 67, resetsAt: 1789952400 } },
  at: '2026-09-20T22:21:35.993Z',
  via: 'cache',
  drift: [],
};

describe('reading plan limits on demand', () => {
  it('needs the token, like everything else', async () => {
    const response = await makeDaemon(async () => reading).app.inject({
      method: 'POST',
      url: '/api/plan-usage/refresh',
    });
    expect(response.statusCode).toBe(401);
  });

  it('puts the reading on the board', async () => {
    const instance = makeDaemon(async () => reading);
    const response = await instance.app.inject({
      method: 'POST',
      url: '/api/plan-usage/refresh',
      headers: auth,
    });

    expect(response.json()).toEqual({ ok: true, via: 'cache', drift: [] });
    expect(instance.projector.snapshot().planUsage?.fiveHour?.usedPercentage).toBe(67);
    // Dated when Claude Code fetched the number, so the board can say how old it is.
    expect(instance.projector.snapshot().planUsageUpdatedAt).toBe('2026-09-20T22:21:35.993Z');
  });

  /**
   * Plan limits belong to the account. If the reading invented a session to hang
   * itself on, the board would grow a lane for a session nobody ran.
   */
  it('does not create a session lane for itself', async () => {
    const instance = makeDaemon(async () => reading);
    await instance.app.inject({ method: 'POST', url: '/api/plan-usage/refresh', headers: auth });
    expect(instance.projector.snapshot().sessions).toEqual([]);
  });

  it('reports why it failed instead of leaving the meters to be read as zero', async () => {
    const instance = makeDaemon(async () => ({ ok: false, reason: 'claude-not-found' }));
    const response = await instance.app.inject({
      method: 'POST',
      url: '/api/plan-usage/refresh',
      headers: auth,
    });

    expect(response.json()).toEqual({ ok: false, reason: 'claude-not-found' });
    expect(instance.projector.snapshot().planUsage).toBeUndefined();
  });

  it('runs one probe at a time, however many tabs ask', async () => {
    let started = 0;
    const instance = makeDaemon(async () => {
      started += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return reading;
    });

    await Promise.all(
      [1, 2, 3].map(() =>
        instance.app.inject({ method: 'POST', url: '/api/plan-usage/refresh', headers: auth }),
      ),
    );
    expect(started).toBe(1);
  });
});

describe('reading plan limits on a timer', () => {
  const stateFile = (fetchedAt: string, fiveHour: number): string => {
    const dir = mkdtempSync(join(tmpdir(), 'mirante-state-'));
    const path = join(dir, '.claude.json');
    writeFileSync(
      path,
      JSON.stringify({
        oauthAccount: { emailAddress: 'someone@example.com' },
        cachedUsageUtilization: {
          fetchedAtMs: Date.parse(fetchedAt),
          utilization: {
            five_hour: { utilization: fiveHour, resets_at: '2026-09-21T15:00:00+00:00' },
            seven_day: { utilization: 60, resets_at: '2026-09-24T08:00:00+00:00' },
          },
        },
      }),
    );
    return path;
  };
  const NOW = new Date('2026-09-21T12:00:30.000Z');
  const polling = (claudeStatePath: string): Daemon => {
    daemon = createDaemon({
      config: loadConfig({
        databasePath: ':memory:',
        port: 7788,
        claudeStatePath,
        planUsagePollMs: 0,
      }),
      token: TOKEN,
      watch: false,
    });
    return daemon;
  };

  it('puts the cached figure on the board, dated when Claude Code fetched it', () => {
    const instance = polling(stateFile('2026-09-21T12:00:00.000Z', 25));
    expect(instance.pollPlanUsageCache(NOW)).toBe(true);
    expect(instance.projector.snapshot().planUsage?.fiveHour?.usedPercentage).toBe(25);
    expect(instance.projector.snapshot().planUsageUpdatedAt).toBe('2026-09-21T12:00:00.000Z');
  });

  /** 1 440 identical rows a day otherwise, and a duplicate on every restart. */
  it('appends nothing when the figure has not changed since the last read', () => {
    const instance = polling(stateFile('2026-09-21T12:00:00.000Z', 25));
    instance.pollPlanUsageCache(NOW);
    const before = instance.log.count();
    expect(instance.pollPlanUsageCache(NOW)).toBe(false);
    expect(instance.log.count()).toBe(before);
  });

  it('does nothing when the cache is missing, rather than failing', () => {
    const instance = polling(join(tmpdir(), 'mirante-no-such-file.json'));
    expect(instance.pollPlanUsageCache(NOW)).toBe(false);
    expect(instance.projector.snapshot().planUsage).toBeUndefined();
  });

  it('never replaces a newer reading with an older one', () => {
    const instance = polling(stateFile('2026-09-21T11:59:00.000Z', 20));
    // A status line reading taken after the cached figure.
    instance.ingest(
      instance.log.appendMany([
        {
          ts: '2026-09-21T12:00:10.000Z',
          source: 'statusline',
          sessionId: 's',
          projectPath: '',
          agentId: 'main',
          kind: 'plan.usage.updated',
          payload: { usage: { fiveHour: { usedPercentage: 30 } } },
        },
      ]),
    );
    instance.pollPlanUsageCache(NOW);
    expect(instance.projector.snapshot().planUsage?.fiveHour?.usedPercentage).toBe(30);
  });

  /**
   * Claude Code rewrites its state file for many reasons besides usage. A new
   * version of the file with the same fetch stamp is the same figure.
   */
  it('recognises the same figure in a rewritten file, across a restart', () => {
    const path = stateFile('2026-09-21T12:00:00.000Z', 25);
    const first = polling(path);
    first.pollPlanUsageCache(NOW);
    // Same figure, file rewritten (new mtime), daemon restarted on the same log.
    const again = createDaemon({
      config: loadConfig({
        databasePath: ':memory:',
        port: 7788,
        claudeStatePath: path,
        planUsagePollMs: 0,
      }),
      token: TOKEN,
      watch: false,
    });
    again.ingest(again.log.appendMany(first.log.since(0)));
    writeFileSync(path, readFileSync(path, 'utf8') + ' ');
    expect(again.pollPlanUsageCache(NOW)).toBe(false);
    void again.close();
  });

  it('stops after close, rather than writing to a closed log', async () => {
    const instance = polling(stateFile('2026-09-21T12:00:00.000Z', 25));
    await instance.close();
    daemon = undefined;
    expect(instance.pollPlanUsageCache(NOW)).toBe(false);
  });

  /** The timer path reads a file. It must never start a process. */
  it('never spawns anything', () => {
    vi.mocked(execFile).mockClear();
    const instance = polling(stateFile('2026-09-21T12:00:00.000Z', 25));
    expect(instance.pollPlanUsageCache(NOW)).toBe(true);
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
  });
});

describe('the automatic reading, while agents work', () => {
  const working = (instance: Daemon, at: Date) =>
    instance.ingest(
      instance.log.appendMany([
        {
          ts: at.toISOString(),
          source: 'hook',
          sessionId: 'busy',
          projectPath: '/w/busy',
          agentId: 'main',
          kind: 'session.started',
          payload: { entrypoint: 'vscode', cwd: '/w/busy' },
        },
        {
          ts: at.toISOString(),
          source: 'hook',
          sessionId: 'busy',
          projectPath: '/w/busy',
          agentId: 'main',
          kind: 'prompt.submitted',
          payload: { preview: 'go', charCount: 2 },
        },
      ]),
    );
  const NOW = new Date('2026-09-21T12:00:00.000Z');
  const quiet = (): Promise<PlanReading> =>
    Promise.resolve({ ok: false, reason: 'command-failed' });

  /** Usage rises only when requests are made; with nothing running, nothing is run. */
  it('runs nothing while no agent is working', async () => {
    let runs = 0;
    const instance = makeDaemon(() => {
      runs += 1;
      return quiet();
    });
    expect(await instance.refreshPlanUsageAutomatically(NOW)).toBe('idle');
    expect(runs).toBe(0);
  });

  it('reads while an agent is working', async () => {
    let runs = 0;
    const instance = makeDaemon(() => {
      runs += 1;
      return Promise.resolve(reading);
    });
    working(instance, NOW);
    expect(await instance.refreshPlanUsageAutomatically(NOW)).toBe('read');
    expect(runs).toBe(1);
    expect(instance.projector.snapshot(NOW.getTime()).planUsage?.fiveHour?.usedPercentage).toBe(67);
  });

  it('does not count an agent silent for over half an hour as working', async () => {
    let runs = 0;
    const instance = makeDaemon(() => {
      runs += 1;
      return quiet();
    });
    working(instance, new Date(NOW.getTime() - 31 * 60_000));
    expect(await instance.refreshPlanUsageAutomatically(NOW)).toBe('idle');
    expect(runs).toBe(0);
  });

  /** A /usage that spent tokens must not be repeated once a minute. */
  it('stops for good the first time /usage is answered by the model', async () => {
    let runs = 0;
    const instance = makeDaemon(() => {
      runs += 1;
      return Promise.resolve({ ok: false, reason: 'not-local' });
    });
    working(instance, NOW);
    expect(await instance.refreshPlanUsageAutomatically(NOW)).toBe('stopped');
    expect(await instance.refreshPlanUsageAutomatically(NOW)).toBe('stopped');
    expect(runs).toBe(1);
  });
});
