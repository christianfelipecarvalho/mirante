import { describe, expect, it } from 'vitest';
import { applyInstall, applyUninstall } from './settings.js';
import type { InstallManifest, InstallPlan, Settings } from './types.js';

const plan: InstallPlan = {
  daemonUrl: 'http://127.0.0.1:7788',
  token: 'token-123',
  transport: 'http',
  statusLineWrapperPath: '/home/user/.mirante/statusline.mjs',
  permissionTimeoutSeconds: 30,
  ingestTimeoutSeconds: 5,
};

const manifestFor = (previous: Record<string, unknown> | null): InstallManifest => ({
  version: 1,
  installedAt: '2026-09-20T00:00:00.000Z',
  settingsPath: '/home/user/.claude/settings.json',
  backupPath: '/home/user/.mirante/backups/settings.json.2026-09-20',
  daemonUrl: plan.daemonUrl,
  transport: 'http',
  hookEvents: [],
  statusLine: { wrapped: true, wrapperPath: plan.statusLineWrapperPath, previous },
});

const roundTrip = (original: Settings) => {
  const installed = applyInstall(original, plan);
  const manifest = manifestFor(installed.previousStatusLine);
  return applyUninstall(installed.settings, manifest).settings;
};

describe('uninstall puts the file back exactly as it was', () => {
  // M1 acceptance criterion 6, checked by structural equality rather than by
  // reading the diff and deciding it looks fine.

  it('for a file that had nothing in it', () => {
    expect(roundTrip({})).toEqual({});
  });

  it('for a file with unrelated settings', () => {
    const original: Settings = { model: 'opus', effortLevel: 'high', tui: 'fullscreen' };
    expect(roundTrip(original)).toEqual(original);
  });

  it('for a file that already had hooks of its own', () => {
    const original: Settings = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/audit.sh' }] },
        ],
        PostToolUse: [{ hooks: [{ type: 'command', command: '/usr/local/bin/notify.sh' }] }],
      },
    };
    expect(roundTrip(original)).toEqual(original);
  });

  it('for a file that already had a status line', () => {
    const original: Settings = {
      statusLine: { type: 'command', command: '~/.claude/my-statusline.sh', padding: 2 },
    };
    expect(roundTrip(original)).toEqual(original);
  });

  it('for a file with both, plus settings we never look at', () => {
    const original: Settings = {
      model: 'opus',
      permissions: { allow: ['WebSearch'] },
      statusLine: { type: 'command', command: 'jq -r .model.display_name', padding: 1 },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: '/opt/start.sh', timeout: 10 }] }],
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '/opt/stop.sh' }] }],
      },
    };
    expect(roundTrip(original)).toEqual(original);
  });
});

describe('install is idempotent', () => {
  it('leaves the same file after running twice', () => {
    const original: Settings = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/x.sh' }] }] },
    };
    const once = applyInstall(original, plan);
    const twice = applyInstall(once.settings, plan, manifestFor(once.previousStatusLine));
    expect(twice.settings).toEqual(once.settings);
  });

  it('does not record its own wrapper as the thing to restore', () => {
    // Otherwise a second install would make uninstall "restore" the wrapper it
    // is in the middle of removing, leaving a status line pointing at nothing.
    const original: Settings = {
      statusLine: { type: 'command', command: '~/.claude/mine.sh' },
    };
    const once = applyInstall(original, plan);
    const twice = applyInstall(once.settings, plan, manifestFor(once.previousStatusLine));
    expect(twice.previousStatusLine).toEqual({ type: 'command', command: '~/.claude/mine.sh' });

    const restored = applyUninstall(twice.settings, manifestFor(twice.previousStatusLine));
    expect(restored.settings.statusLine).toEqual({ type: 'command', command: '~/.claude/mine.sh' });
  });
});

describe('install does not disturb what is already there', () => {
  const original: Settings = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/audit.sh' }] }],
    },
  };
  const result = applyInstall(original, plan);
  const groups = (result.settings.hooks as Record<string, unknown[]>).PreToolUse ?? [];

  it("keeps the user's group untouched and adds its own beside it", () => {
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: '/audit.sh' }],
    });
  });

  it('points its hook at the local daemon with the token attached', () => {
    const ours = (groups[1] as { hooks: Record<string, unknown>[] }).hooks[0];
    expect(ours).toMatchObject({
      type: 'http',
      url: 'http://127.0.0.1:7788/ingest/hook',
      headers: { Authorization: 'Bearer token-123' },
    });
  });

  it('gives permission a longer timeout than ingest, so a click can still win', () => {
    const hooks = result.settings.hooks as Record<string, { hooks: { timeout: number }[] }[]>;
    const permission = hooks.PermissionRequest?.at(-1)?.hooks[0]?.timeout;
    const ingest = hooks.PreToolUse?.at(-1)?.hooks[0]?.timeout;
    expect(permission).toBe(30);
    expect(ingest).toBe(5);
    expect(permission).toBeGreaterThan(ingest as number);
  });
});

describe('uninstall is careful about what it did not write', () => {
  it('leaves a status line the user changed after install', () => {
    const installed = applyInstall({}, plan);
    const edited: Settings = {
      ...installed.settings,
      statusLine: { type: 'command', command: '~/.claude/something-else.sh' },
    };
    const result = applyUninstall(edited, manifestFor(null));
    expect(result.settings.statusLine).toEqual({
      type: 'command',
      command: '~/.claude/something-else.sh',
    });
    expect(result.changes.join(' ')).toContain('left alone');
  });

  it('removes a hook Mirante added without removing one the user added to the same event', () => {
    const original: Settings = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/mine.sh' }] }] },
    };
    const installed = applyInstall(original, plan);
    const result = applyUninstall(installed.settings, manifestFor(null));
    expect(result.settings.hooks).toEqual(original.hooks);
  });
});
