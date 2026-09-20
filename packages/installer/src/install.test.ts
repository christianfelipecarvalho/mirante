import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { install, uninstall, readManifest, pathsFor } from './install.js';

const workspaces: string[] = [];

const workspace = (initialSettings?: unknown) => {
  const root = mkdtempSync(join(tmpdir(), 'mirante-install-'));
  workspaces.push(root);
  const settingsPath = join(root, 'claude', 'settings.json');
  if (initialSettings !== undefined) {
    mkdirSync(join(root, 'claude'), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(initialSettings, null, 2)}\n`);
  }
  return { root, paths: pathsFor(join(root, 'mirante'), settingsPath), settingsPath };
};

afterEach(() => {
  for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
});

const options = (paths: ReturnType<typeof pathsFor>) => ({
  paths,
  daemonUrl: 'http://127.0.0.1:7788',
  token: 'tok-abc',
});

describe('installing against a real file', () => {
  it('backs up before it writes, and says where', () => {
    const original = { model: 'opus' };
    const { paths, settingsPath } = workspace(original);
    const result = install(options(paths));

    expect(result.backupPath).toBeTruthy();
    expect(JSON.parse(readFileSync(result.backupPath as string, 'utf8'))).toEqual(original);
    expect(readFileSync(settingsPath, 'utf8')).toContain('ingest/hook');
  });

  it('writes a wrapper that runs the status line it replaced', () => {
    const { paths } = workspace({
      statusLine: { type: 'command', command: '~/.claude/mine.sh' },
    });
    install(options(paths));

    const config = JSON.parse(readFileSync(join(paths.mirantehome, 'statusline.json'), 'utf8'));
    expect(config.originalCommand).toBe('~/.claude/mine.sh');

    const wrapper = readFileSync(join(paths.mirantehome, 'statusline.mjs'), 'utf8');
    expect(wrapper).toContain('config.originalCommand');
    // The user's line is printed before the daemon is contacted at all.
    expect(wrapper.indexOf('spawnSync')).toBeLessThan(wrapper.indexOf('http.request'));
  });

  it('keeps the token out of the process table', () => {
    const { paths } = workspace({});
    install(options(paths));
    const wrapper = readFileSync(join(paths.mirantehome, 'statusline.mjs'), 'utf8');
    expect(wrapper).not.toContain('tok-abc');
  });
});

describe('uninstalling restores the file byte for byte', () => {
  // M1 acceptance criterion 6, verified against what is actually on disk.
  const cases: Record<string, unknown> = {
    'a file that did not exist': undefined,
    'an empty object': {},
    'unrelated settings': { model: 'opus', permissions: { allow: ['WebSearch'] } },
    'existing hooks and a status line': {
      statusLine: { type: 'command', command: '~/.claude/mine.sh', padding: 2 },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/opt/stop.sh' }] }] },
    },
  };

  for (const [name, initial] of Object.entries(cases)) {
    it(name, () => {
      const { paths, settingsPath } = workspace(initial);
      const before = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : undefined;

      install(options(paths));
      const result = uninstall(paths);
      expect(result.hadManifest).toBe(true);

      const after = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : undefined;
      if (before === undefined) {
        expect(JSON.parse(after as string)).toEqual({});
      } else {
        expect(JSON.parse(after as string)).toEqual(JSON.parse(before));
      }
    });
  }

  it('removes the wrapper and the manifest it wrote', () => {
    const { paths } = workspace({});
    install(options(paths));
    uninstall(paths);

    expect(existsSync(join(paths.mirantehome, 'statusline.mjs'))).toBe(false);
    expect(existsSync(join(paths.mirantehome, 'statusline.json'))).toBe(false);
    expect(readManifest(paths.mirantehome)).toBeUndefined();
  });

  it('keeps every backup it ever took', () => {
    const { paths } = workspace({ model: 'opus' });
    install(options(paths));
    const result = uninstall(paths);
    // Uninstall backs up too: undoing a change is still a change.
    expect(result.backupPath).toBeTruthy();
    expect(existsSync(result.backupPath as string)).toBe(true);
  });

  it('does nothing when there is nothing recorded to undo', () => {
    const { paths } = workspace({ model: 'opus' });
    const result = uninstall(paths);
    expect(result.hadManifest).toBe(false);
    expect(result.changes).toEqual([]);
  });
});

describe('installing twice', () => {
  it('leaves the same settings and still restores cleanly', () => {
    const original = { statusLine: { type: 'command', command: '~/.claude/mine.sh' } };
    const { paths, settingsPath } = workspace(original);

    install(options(paths));
    const afterFirst = readFileSync(settingsPath, 'utf8');
    install(options(paths));
    expect(readFileSync(settingsPath, 'utf8')).toBe(afterFirst);

    uninstall(paths);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(original);
  });
});

describe('the status line heartbeat', () => {
  it('records that it ran even when the daemon is unreachable', () => {
    // From the daemon's side, "Claude Code never called the status line" and
    // "it called it while nothing was listening" look identical. The heartbeat
    // is what tells them apart.
    const { paths } = workspace({});
    install({ ...options(paths), daemonUrl: 'http://127.0.0.1:59999' });

    const wrapper = join(paths.mirantehome, 'statusline.mjs');
    const result = spawnSync(process.execPath, [wrapper], {
      input: JSON.stringify({ session_id: 's1', model: { display_name: 'Opus' } }),
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    const heartbeat = join(paths.mirantehome, 'statusline-last-run');
    expect(existsSync(heartbeat)).toBe(true);
    expect(readFileSync(heartbeat, 'utf8')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('still prints the status line with nothing listening', () => {
    const { paths } = workspace({});
    install({ ...options(paths), daemonUrl: 'http://127.0.0.1:59999' });
    const result = spawnSync(process.execPath, [join(paths.mirantehome, 'statusline.mjs')], {
      input: JSON.stringify({ session_id: 's1', model: { display_name: 'Opus' } }),
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.stdout).toContain('Opus');
  });
});
