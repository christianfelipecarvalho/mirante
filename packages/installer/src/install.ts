import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { backupFile, readSettings, writeFileWithMode, writeJsonAtomic } from './io.js';
import { applyInstall, applyUninstall } from './settings.js';
import { statusLineWrapperSource, type StatusLineWrapperConfig } from './statusline-wrapper.js';
import {
  HOOK_EVENTS,
  manifestSchema,
  type HookTransport,
  type InstallManifest,
  type InstallPlan,
} from './types.js';

export const defaultSettingsPath = (): string => join(homedir(), '.claude', 'settings.json');

export type InstallPaths = {
  mirantehome: string;
  settingsPath: string;
};

export const pathsFor = (
  mirantehome: string,
  settingsPath = defaultSettingsPath(),
): InstallPaths => ({
  mirantehome,
  settingsPath,
});

const manifestPath = (home: string) => join(home, 'install-manifest.json');
const wrapperPath = (home: string) => join(home, 'statusline.mjs');
const wrapperConfigPath = (home: string) => join(home, 'statusline.json');
const backupsDir = (home: string) => join(home, 'backups');

export const readManifest = (home: string): InstallManifest | undefined => {
  const path = manifestPath(home);
  if (!existsSync(path)) return undefined;
  const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  return parsed.success ? parsed.data : undefined;
};

export type InstallOptions = {
  paths: InstallPaths;
  daemonUrl: string;
  token: string;
  transport?: HookTransport;
  /** Must outlast the daemon's approval window, or a click can never arrive in time. */
  permissionTimeoutSeconds?: number;
  ingestTimeoutSeconds?: number;
};

export type InstallOutcome = {
  manifest: InstallManifest;
  changes: string[];
  backupPath: string | undefined;
  /** True when settings.json is readable beyond the owner, since it now holds the token. */
  settingsWorldReadable: boolean;
};

export const install = (options: InstallOptions): InstallOutcome => {
  const { paths, daemonUrl, token } = options;
  const plan: InstallPlan = {
    daemonUrl,
    token,
    transport: options.transport ?? 'http',
    statusLineWrapperPath: wrapperPath(paths.mirantehome),
    permissionTimeoutSeconds: options.permissionTimeoutSeconds ?? 30,
    ingestTimeoutSeconds: options.ingestTimeoutSeconds ?? 5,
  };

  const existing = readManifest(paths.mirantehome);
  const before = readSettings(paths.settingsPath);
  const result = applyInstall(before, plan, existing);

  // Nothing is written until the new content is known to be producible.
  const backupPath = backupFile(paths.settingsPath, backupsDir(paths.mirantehome));

  const previousCommand =
    typeof result.previousStatusLine?.command === 'string'
      ? result.previousStatusLine.command
      : null;
  const wrapperConfig: StatusLineWrapperConfig = {
    daemonUrl,
    token,
    originalCommand: previousCommand,
  };
  writeFileWithMode(
    wrapperConfigPath(paths.mirantehome),
    `${JSON.stringify(wrapperConfig, null, 2)}\n`,
    0o600,
  );
  writeFileWithMode(
    plan.statusLineWrapperPath,
    statusLineWrapperSource(wrapperConfigPath(paths.mirantehome)),
    0o700,
  );

  writeJsonAtomic(paths.settingsPath, result.settings, 0o600);

  const manifest: InstallManifest = {
    version: 1,
    installedAt: new Date().toISOString(),
    settingsPath: paths.settingsPath,
    backupPath: backupPath ?? '',
    daemonUrl,
    transport: plan.transport,
    hookEvents: [...HOOK_EVENTS],
    statusLine: {
      wrapped: previousCommand !== null,
      wrapperPath: plan.statusLineWrapperPath,
      previous: result.previousStatusLine,
    },
  };
  writeJsonAtomic(manifestPath(paths.mirantehome), manifest, 0o600);

  return {
    manifest,
    changes: result.changes,
    backupPath,
    settingsWorldReadable: isWorldReadable(paths.settingsPath),
  };
};

/** settings.json carries the token in a hook header, so anyone who can read the file has it. */
const isWorldReadable = (path: string): boolean => {
  try {
    return (statSync(path).mode & 0o077) !== 0;
  } catch {
    return false;
  }
};

export type UninstallOutcome = {
  changes: string[];
  backupPath: string | undefined;
  /** False when there was nothing recorded to undo. */
  hadManifest: boolean;
};

export const uninstall = (paths: InstallPaths): UninstallOutcome => {
  const manifest = readManifest(paths.mirantehome);
  if (!manifest) return { changes: [], backupPath: undefined, hadManifest: false };

  const before = readSettings(manifest.settingsPath || paths.settingsPath);
  const result = applyUninstall(before, manifest);
  const backupPath = backupFile(
    manifest.settingsPath || paths.settingsPath,
    backupsDir(paths.mirantehome),
  );
  writeJsonAtomic(manifest.settingsPath || paths.settingsPath, result.settings, 0o600);

  for (const path of [
    wrapperPath(paths.mirantehome),
    wrapperConfigPath(paths.mirantehome),
    manifestPath(paths.mirantehome),
  ]) {
    try {
      rmSync(path, { force: true });
    } catch {
      // Leaving a stale wrapper behind is untidy but harmless; failing the
      // uninstall over it would not be.
    }
  }

  return { changes: result.changes, backupPath, hadManifest: true };
};
