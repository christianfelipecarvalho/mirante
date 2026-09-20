import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDaemon, loadConfig, parseSessionTranscript } from '@mirante/daemon';
import { projectBoard, type MiranteEvent } from '@mirante/shared';
import { loadFixture } from './helpers/fixtures.js';

/**
 * M1 acceptance criterion 8, and the enforcement half of ADR-0005.
 *
 * The ESLint rule that blocks `fetch` catches the obvious case at review time.
 * This catches the rest: a transitive dependency phoning home, an update check
 * someone added, a crash reporter. Mirante reads prompts and tool inputs — the
 * claim that none of it leaves the machine has to be tested, not asserted.
 */
const attempts: string[] = [];

const originals = {
  socketConnect: net.Socket.prototype.connect,
  netConnect: net.connect,
  tlsConnect: tls.connect,
  httpRequest: http.request,
  httpsRequest: https.request,
  dnsLookup: dns.lookup,
  fetch: globalThis.fetch,
};

const record =
  (what: string) =>
  (...args: unknown[]) => {
    attempts.push(`${what}(${JSON.stringify(args[0] ?? null)})`);
    throw new Error(`Mirante attempted an outbound connection: ${what}`);
  };

beforeAll(() => {
  net.Socket.prototype.connect = record('net.Socket.connect') as never;
  (net as { connect: unknown }).connect = record('net.connect');
  (tls as { connect: unknown }).connect = record('tls.connect');
  (http as { request: unknown }).request = record('http.request');
  (https as { request: unknown }).request = record('https.request');
  (dns as { lookup: unknown }).lookup = record('dns.lookup');
  (globalThis as { fetch: unknown }).fetch = record('fetch');
});

afterAll(() => {
  net.Socket.prototype.connect = originals.socketConnect;
  (net as { connect: unknown }).connect = originals.netConnect;
  (tls as { connect: unknown }).connect = originals.tlsConnect;
  (http as { request: unknown }).request = originals.httpRequest;
  (https as { request: unknown }).request = originals.httpsRequest;
  (dns as { lookup: unknown }).lookup = originals.dnsLookup;
  (globalThis as { fetch: unknown }).fetch = originals.fetch;
});

describe('nothing leaves the machine', () => {
  it('stays silent through a full ingest, parse, project and serve cycle', async () => {
    const config = loadConfig({ databasePath: ':memory:', port: 7788 });
    const token = 'c'.repeat(64);
    const daemon = createDaemon({ config, token, watch: false });
    const auth = { authorization: `Bearer ${token}` };

    await daemon.app.inject({
      method: 'POST',
      url: '/ingest/hook',
      headers: auth,
      payload: {
        hook_event_name: 'SessionStart',
        session_id: 'sess-1',
        cwd: '/home/user/project',
      },
    });

    await daemon.app.inject({
      method: 'POST',
      url: '/ingest/hook',
      headers: auth,
      payload: {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        cwd: '/home/user/project',
        tool_name: 'Bash',
        tool_use_id: 'toolu_1',
        tool_input: { command: 'echo hi' },
      },
    });

    await daemon.app.inject({
      method: 'POST',
      url: '/ingest/statusline',
      headers: auth,
      payload: {
        session_id: 'sess-1',
        cost: { total_cost_usd: 0.12 },
        rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1790000000 } },
      },
    });

    await daemon.app.inject({ method: 'GET', url: '/api/state', headers: auth });
    await daemon.app.inject({ method: 'GET', url: '/api/events?since=0', headers: auth });

    // The transcript path too: parsing a real session and projecting it.
    const fixture = loadFixture('subagent-fanout');
    const parsed = parseSessionTranscript({
      mainLines: fixture.mainLines,
      subagents: fixture.subagents,
    });
    projectBoard(
      parsed.events.map((draft, index) => ({
        ...draft,
        id: index + 1,
        receivedTs: draft.ts,
      })) as MiranteEvent[],
    );

    await daemon.close();

    expect(attempts).toEqual([]);
  });
});
