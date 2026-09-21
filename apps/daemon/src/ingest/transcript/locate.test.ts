import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { locateSessions, projectSlug } from './locate.js';

let root: string | undefined;

const projectsDir = (): string => {
  root = mkdtempSync(join(tmpdir(), 'mirante-locate-'));
  return root;
};

const session = (dir: string, slug: string, sessionId: string): void => {
  mkdirSync(join(dir, slug), { recursive: true });
  writeFileSync(
    join(dir, slug, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: 'user', sessionId, cwd: '/x', timestamp: new Date().toISOString() })}\n`,
  );
};

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('projectSlug', () => {
  it('flattens a path the way Claude Code names its project directories', () => {
    expect(projectSlug('/home/user/.mirante/probe')).toBe('-home-user--mirante-probe');
  });
});

describe('locateSessions', () => {
  it('finds a session', () => {
    const dir = projectsDir();
    session(dir, '-home-user-work', 'sess-1');
    expect(locateSessions(dir).map((s) => s.sessionId)).toEqual(['sess-1']);
  });

  /**
   * Mirante's own `/usage` probe runs Claude Code, and Claude Code writes a
   * transcript whether or not hooks were loaded. Without this, the board grows a
   * session for a project the user never opened — observed, once, before the
   * exclusion existed.
   */
  it('skips a project directory it was told to ignore', () => {
    const dir = projectsDir();
    session(dir, '-home-user-work', 'sess-1');
    session(dir, '-home-user--mirante-probe', 'probe-1');

    const found = locateSessions(dir, undefined, new Set(['-home-user--mirante-probe']));
    expect(found.map((s) => s.sessionId)).toEqual(['sess-1']);
  });
});
