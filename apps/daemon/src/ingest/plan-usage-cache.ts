import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { PLAN_READING_MAX_AGE_MS, type PlanUsage } from '@mirante/shared';

/**
 * Plan limits as Claude Code already holds them on disk.
 *
 * Claude Code keeps it in `~/.claude.json` under `cachedUsageUtilization`, and
 * writes it when `/usage` fetches it — not as it works (measured; see ADR-0007).
 * Reading it costs nothing, takes no subprocess, and causes no traffic at all.
 *
 * **Only the two windows are taken.** That file also holds account identity, and
 * none of it is read into anything Mirante keeps. The schema below names every
 * field that survives, and a test asserts nothing else does. Mirante still never
 * reads a credential: credentials live in `.credentials.json`, which this never
 * opens. See ADR-0006.
 */
export const CACHE_ADAPTER_VERSION = 1;

/**
 * How long a cached reading is worth showing.
 *
 * Matches the age at which Claude Code itself stops trusting the blob and
 * refetches. Past it, the reading is not wrong so much as unanchored: the window
 * may have rolled over entirely.
 */
export const CACHE_MAX_AGE_MS = PLAN_READING_MAX_AGE_MS;

/**
 * Above this the file is not read at all. It is normally ~100 KB, but it grows
 * for heavy users, and parsing is synchronous on the event loop hook responses
 * depend on.
 */
export const STATE_FILE_MAX_BYTES = 16 * 1024 * 1024;

/** A window, as this file stores it: whole percent, and an ISO instant. */
const windowSchema = z.object({
  utilization: z.number().min(0),
  resets_at: z.string().min(1).optional(),
});

/**
 * Deliberately narrow. `.passthrough()` is not used anywhere here: whatever else
 * the file holds must not survive the parse.
 */
const cacheSchema = z.object({
  // Read only to compare with the cache's own account, then dropped. Claude Code
  // discards a cache written for another account; so does this.
  oauthAccount: z.object({ accountUuid: z.string().optional() }).optional(),
  cachedUsageUtilization: z.object({
    fetchedAtMs: z.number().int().positive(),
    accountUuid: z.string().optional(),
    utilization: z.object({
      five_hour: windowSchema.nullish(),
      seven_day: windowSchema.nullish(),
    }),
  }),
});

export type CachedReading = {
  usage: PlanUsage;
  /** When Claude Code fetched the figure, not when Mirante read the file. */
  fetchedAt: string;
  /** The same instant, as Claude Code stamps it. Identifies the write. */
  fetchedAtMs: number;
};

const epochSecondsOf = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
};

const windowOf = (raw: z.infer<typeof windowSchema> | null | undefined) => {
  if (!raw) return undefined;
  const resetsAt = epochSecondsOf(raw.resets_at);
  return {
    usedPercentage: raw.utilization,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
};

export type CacheFailure =
  | 'missing'
  | 'unreadable'
  | 'stale'
  | 'empty'
  | 'too-large'
  /** Written in the future by this machine's clock — it was stepped backwards. */
  | 'clock'
  /** Written for an account other than the one now signed in. */
  | 'other-account';

/**
 * Turns the stored blob into a reading.
 *
 * Pure: takes the parsed JSON, returns the two windows or a reason there are
 * none. Nothing here touches the filesystem.
 */
export const readCachedUsage = (
  contents: unknown,
  now: Date,
): { ok: true; reading: CachedReading } | { ok: false; reason: CacheFailure } => {
  const parsed = cacheSchema.safeParse(contents);
  if (!parsed.success) return { ok: false, reason: 'missing' };

  const { fetchedAtMs, utilization, accountUuid } = parsed.data.cachedUsageUtilization;
  const signedIn = parsed.data.oauthAccount?.accountUuid;
  if (accountUuid && signedIn && accountUuid !== signedIn) {
    return { ok: false, reason: 'other-account' };
  }
  const age = now.getTime() - fetchedAtMs;
  // Claude Code treats a negative age as no reading; a future stamp would
  // otherwise read as "just now" until the clock caught up.
  if (age < 0) return { ok: false, reason: 'clock' };
  if (age > CACHE_MAX_AGE_MS) return { ok: false, reason: 'stale' };

  const usage: PlanUsage = {};
  const fiveHour = windowOf(utilization.five_hour);
  const sevenDay = windowOf(utilization.seven_day);
  if (fiveHour) usage.fiveHour = fiveHour;
  if (sevenDay) usage.sevenDay = sevenDay;

  // An account with no plan windows. Absence is not zero.
  if (Object.keys(usage).length === 0) return { ok: false, reason: 'empty' };

  return {
    ok: true,
    reading: { usage, fetchedAt: new Date(fetchedAtMs).toISOString(), fetchedAtMs },
  };
};

/**
 * Identifies one version of the file: inode, size and modification time.
 *
 * Claude Code replaces the file by rename, so a new version is a new inode. A
 * poller that remembers the last signature parses nothing while nothing changed.
 */
export const stateFileSignature = (path: string): string | undefined => {
  try {
    const stat = statSync(path);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
};

/** Reads the file, then hands the contents to the pure reader above. */
export const readCachedUsageFile = (
  path: string,
  now = new Date(),
): { ok: true; reading: CachedReading } | { ok: false; reason: CacheFailure } => {
  let contents: unknown;
  try {
    if (statSync(path).size > STATE_FILE_MAX_BYTES) return { ok: false, reason: 'too-large' };
    contents = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Never log what was caught: a JSON.parse message can quote the start of
    // the input, and this file holds the account's email.
    // Absent, mid-write, or not ours to read. None of those is an error worth
    // surfacing on its own: the caller falls back to asking Claude Code.
    return { ok: false, reason: 'unreadable' };
  }
  return readCachedUsage(contents, now);
};
