import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemon, type Daemon } from './index.js';
import { loadConfig } from '../config.js';
import { EventLog } from '../core/eventlog.js';
import type { ControlLauncher, ControlProcess } from '../core/agent-control.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const token = 'a'.repeat(64);
const auth = { authorization: `Bearer ${token}`, origin: 'http://127.0.0.1:7788' };
const homes: string[] = [];
let daemon: Daemon | undefined;
class ProcessDouble extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = null;
  pid = undefined;
  kill = vi.fn(() => true);
}
const make = (hold = false) => {
  const home = mkdtempSync(join(tmpdir(), 'mirante-control-api-'));
  homes.push(home);
  const children: ProcessDouble[] = [];
  const launch = vi.fn<ControlLauncher>(() => {
    const child = new ProcessDouble();
    children.push(child);
    queueMicrotask(() => {
      child.emit('spawn');
      if (!hold) {
        child.stdout.write(
          `${JSON.stringify({ type: 'result', subtype: 'success', structured_output: { agentId: 'worker-1', verdict: 'pending', summary: 'Faltam testes no componente.' } })}\n`,
        );
        child.emit('close', 0);
      }
    });
    return child as unknown as ControlProcess;
  });
  const terminate = vi.fn((child: ControlProcess) =>
    (child as unknown as ProcessDouble).emit('close', null, 'SIGINT'),
  );
  daemon = createDaemon({
    config: loadConfig({ home, databasePath: ':memory:', port: 7788 }),
    token,
    watch: false,
    controlLauncher: launch,
    controlTerminate: terminate,
  });
  const ts = new Date(Date.now() - 60_000).toISOString();
  const base = { ts, source: 'sdk' as const, sessionId, projectPath: home, agentId: 'main' };
  daemon.ingest(
    daemon.log.appendMany([
      { ...base, kind: 'session.started', payload: { entrypoint: 'cli', cwd: home } },
      {
        ...base,
        agentId: 'worker-1',
        parentAgentId: 'main',
        kind: 'agent.started',
        payload: { agentType: 'general-purpose', spawnMode: 'async' },
      },
      { ...base, agentId: 'worker-1', kind: 'agent.finished', payload: { outcome: 'interrupted' } },
      { ...base, kind: 'session.ended', payload: { reason: 'exit' } },
    ]),
  );
  return { daemon, launch, terminate, children };
};
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const endpoint = `/api/sessions/${sessionId}/agents/control`;

describe('the authenticated control channel', () => {
  it('rejects foreign origins, missing tokens and extra command fields before launching anything', async () => {
    const { daemon, launch } = make();
    for (const headers of [{}, { ...auth, origin: 'https://evil.example' }]) {
      const r = await daemon.app.inject({
        method: 'POST',
        url: endpoint,
        headers,
        payload: { action: 'resume', agentIds: ['worker-1'] },
      });
      expect([401, 403]).toContain(r.statusCode);
    }
    const r = await daemon.app.inject({
      method: 'POST',
      url: endpoint,
      headers: auth,
      payload: { action: 'resume', agentIds: ['worker-1'], command: 'rm -rf /' },
    });
    expect(r.statusCode).toBe(400);
    expect(launch).not.toHaveBeenCalled();
  });
  it('records a real request and its acknowledged result without overwriting interrupted task evidence', async () => {
    const { daemon, launch } = make();
    const r = await daemon.app.inject({
      method: 'POST',
      url: endpoint,
      headers: auth,
      payload: { action: 'verify', agentIds: ['worker-1'] },
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ ok: true, runIds: [expect.any(String)] });
    await vi.waitFor(() =>
      expect(daemon.projector.snapshot().controlRuns?.[0]?.status).toBe('completed'),
    );
    expect(launch).toHaveBeenCalledTimes(1);
    expect(
      daemon.projector.snapshot().sessions[0]?.cards.find((c) => c.agentId === 'worker-1')?.outcome,
    ).toBe('interrupted');
    expect(
      daemon.log.since(0).filter((e) => e.kind === 'agent.control.updated').length,
    ).toBeGreaterThanOrEqual(3);
  });
  it('stops only the requested owned run and rejects unknown process references', async () => {
    const { daemon, terminate } = make(true);
    const r = await daemon.app.inject({
      method: 'POST',
      url: endpoint,
      headers: auth,
      payload: { action: 'resume', agentIds: ['worker-1'] },
    });
    const { runIds } = r.json() as { runIds: string[] };
    const unknown = await daemon.app.inject({
      method: 'POST',
      url: endpoint,
      headers: auth,
      payload: { action: 'stop', runIds: ['33333333-3333-4333-8333-333333333333'] },
    });
    expect(unknown.statusCode).toBe(409);
    expect(terminate).not.toHaveBeenCalled();
    const stop = await daemon.app.inject({
      method: 'POST',
      url: endpoint,
      headers: auth,
      payload: { action: 'stop', runIds },
    });
    expect(stop.statusCode).toBe(202);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(daemon.projector.snapshot().controlRuns?.[0]?.status).toBe('interrupted');
  });
  it('marks a recovery from a crashed daemon unknown and never restarts it on boot', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mirante-control-replay-'));
    homes.push(home);
    const databasePath = join(home, 'history.db');
    const log = new EventLog(databasePath);
    const requestedAt = new Date().toISOString();
    log.appendMany([
      {
        ts: requestedAt,
        source: 'sdk',
        sessionId,
        projectPath: home,
        agentId: 'worker-1',
        kind: 'agent.control.updated',
        payload: { runId: 'old-run', operation: 'resume', status: 'running', requestedAt },
      },
    ]);
    log.close();
    const launch = vi.fn<ControlLauncher>();
    daemon = createDaemon({
      config: loadConfig({ home, databasePath }),
      token,
      watch: false,
      controlLauncher: launch,
    });
    expect(daemon.projector.snapshot().controlRuns?.[0]).toMatchObject({
      status: 'lost',
      verdict: 'unknown',
      reason: 'not-owned',
    });
    expect(launch).not.toHaveBeenCalled();
    expect(daemon.projector.snapshot().sessions).toEqual([]);
  });
});
