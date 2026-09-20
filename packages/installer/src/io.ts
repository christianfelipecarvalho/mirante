import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Settings } from './types.js';

export const readSettings = (path: string): Settings => {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.length === 0) return {};
  return JSON.parse(raw) as Settings;
};

/**
 * Writes through a temporary file in the same directory, then renames.
 *
 * A crash midway through writing someone's settings.json would leave Claude Code
 * unable to start. Rename is atomic within a filesystem, so the file is either
 * the old one or the new one and never a half-written one.
 */
export const writeJsonAtomic = (path: string, value: unknown, mode = 0o600): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.mirante-tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(temporary, path);
};

export const writeFileWithMode = (path: string, contents: string, mode: number): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
};

/**
 * A dated copy of a file before it is touched.
 *
 * Returns the backup path so it can be recorded in the manifest and printed:
 * a backup nobody can find is not a backup.
 */
export const backupFile = (path: string, backupsDir: string): string | undefined => {
  if (!existsSync(path)) return undefined;
  mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(backupsDir, `${path.split('/').pop() ?? 'settings.json'}.${stamp}.bak`);
  copyFileSync(path, target);
  return target;
};
