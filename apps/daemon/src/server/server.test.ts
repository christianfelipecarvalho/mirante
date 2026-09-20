import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemon, type Daemon } from './index.js';
import { loadConfig } from '../config.js';

const TOKEN = 'a'.repeat(64);
const PORT = 7788;

const config = loadConfig({ databasePath: ':memory:', port: PORT, approvalWindowMs: 150 });

let daemon: Daemon | undefined;
const makeDaemon = (): Daemon => {
  daemon = createDaemon({ config, token: TOKEN, watch: false });
  return daemon;
};

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

const auth = { authorization: `Bearer ${TOKEN}` };

const sessionStartBody = {
  hook_event_name: 'SessionStart',
  session_id: 'sess-1',
  cwd: '/home/user/project',
};

describe('the daemon refuses anything it cannot vouch for', () => {
  it('rejects a request with no token', async () => {
    const response = await makeDaemon().app.inject({
      method: 'POST',
      url: '/ingest/hook',
      payload: sessionStartBody,
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const response = await makeDaemon().app.inject({
      method: 'POST',
      url: '/ingest/hook',
      headers: { authorization: `Bearer ${'b'.repeat(64)}` },
      payload: sessionStartBody,
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a foreign Origin even when the token is correct', async () => {
    // A page you happen to have open must not be able to read your prompts, and
    // it cannot forge Origin. M1 acceptance criterion 7.
    const response = await makeDaemon().app.inject({
      method: 'GET',
      url: '/api/state',
      headers: { ...auth, origin: 'https://evil.example' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('accepts its own origin', async () => {
    const response = await makeDaemon().app.inject({
      method: 'GET',
      url: '/api/state',
      headers: { ...auth, origin: `http://127.0.0.1:${PORT}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it('accepts a hook, which sends no Origin at all', async () => {
    const response = await makeDaemon().app.inject({
      method: 'POST',
      url: '/ingest/hook',
      headers: auth,
      payload: sessionStartBody,
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('ingest builds the board', () => {
  it('turns a hook into a lane a client can read back', async () => {
    const d = makeDaemon();
    await d.app.inject({
      method: 'POST',
      url: '/ingest/hook',
      headers: auth,
      payload: sessionStartBody,
    });
    const state = await d.app.inject({ method: 'GET', url: '/api/state', headers: auth });
    const board = state.json() as { sessions: { sessionId: string }[] };
    expect(board.sessions.map((s) => s.sessionId)).toEqual(['sess-1']);
  });

  it('replays from an event id so a reopened browser rebuilds the board', async () => {
    const d = makeDaemon();
    await d.app.inject({
      method: 'POST',
      url: '/ingest/hook',
      headers: auth,
      payload: sessionStartBody,
    });
    const all = (
      await d.app.inject({ method: 'GET', url: '/api/events?since=0', headers: auth })
    ).json() as {
      events: { id: number }[];
    };
    expect(all.events.length).toBeGreaterThan(0);

    const after = (
      await d.app.inject({
        method: 'GET',
        url: `/api/events?since=${all.events.at(-1)?.id}`,
        headers: auth,
      })
    ).json() as { events: unknown[] };
    expect(after.events).toEqual([]);
  });

  it('never answers a hook with an error, whatever it was sent', async () => {
    // A confused Mirante must not change how a Claude Code session behaves.
    const response = await makeDaemon().app.inject({
      method: 'POST',
      url: '/ingest/hook',
      headers: auth,
      payload: { nonsense: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });
});

describe('approving a tool from the board', () => {
  const permissionBody = {
    hook_event_name: 'PermissionRequest',
    session_id: 'sess-1',
    cwd: '/home/user/project',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf build/' },
  };

  it('returns an allow decision when someone clicks in time', async () => {
    const d = makeDaemon();
    const hook = d.app.inject({
      method: 'POST',
      url: '/ingest/hook',
      headers: auth,
      payload: permissionBody,
    });

    // Wait for the request to reach the board, then answer it the way the UI would.
    await vi.waitFor(() => expect(d.projector.snapshot().pendingApprovals).toHaveLength(1));
    const requestId = d.projector.snapshot().pendingApprovals[0]?.requestId as string;
    const click = await d.app.inject({
      method: 'POST',
      url: `/api/permissions/${requestId}`,
      headers: auth,
      payload: { behavior: 'allow' },
    });
    expect(click.json()).toEqual({ accepted: true });

    const response = await hook;
    expect(response.json()).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });

  it('returns no decision when nobody clicks, so the terminal asks instead', async () => {
    // There is no "ask" decision to return. Falling back is the absence of a
    // decision object, which leaves Claude Code's permission flow untouched.
    // M1 acceptance criterion 5.
    const d = makeDaemon();
    const response = await d.app.inject({
      method: 'POST',
      url: '/ingest/hook',
      headers: auth,
      payload: permissionBody,
    });
    expect(response.json()).toEqual({});

    const board = d.projector.snapshot();
    expect(board.pendingApprovals).toHaveLength(0);
    expect(board.timeline.map((t) => t.text)).toContain('Permission asked in terminal');
  });

  it('tells the UI when a click arrived after the window closed', async () => {
    const d = makeDaemon();
    await d.app.inject({
      method: 'POST',
      url: '/ingest/hook',
      headers: auth,
      payload: permissionBody,
    });
    const late = await d.app.inject({
      method: 'POST',
      url: '/api/permissions/does-not-exist',
      headers: auth,
      payload: { behavior: 'allow' },
    });
    expect(late.json()).toEqual({ accepted: false });
  });
});
