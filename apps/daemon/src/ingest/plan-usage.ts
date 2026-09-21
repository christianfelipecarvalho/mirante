import type { PlanUsage } from '@mirante/shared';
import { readCachedUsageFile } from './plan-usage-cache.js';
import { probePlanUsage, type UsageProbeFailure } from './usage-command.js';

/**
 * Where a reading came from. Recorded for the daemon log and for `doctor`, not
 * for the interface — the board must not branch on provenance (ADR-0001).
 */
export type PlanUsageVia = 'cache' | 'command';

export type PlanReading =
  | {
      ok: true;
      usage: PlanUsage;
      at: string;
      via: PlanUsageVia;
      drift: string[];
      /** For a cached figure: Claude Code's stamp, which identifies the write. */
      fetchedAtMs?: number;
    }
  | { ok: false; reason: UsageProbeFailure };

export type ReadPlanUsageOptions = {
  /** Claude Code's own state file, where it caches the figure it last fetched. */
  statePath: string;
  /** Where the fallback probe runs, outside any project. */
  probeCwd: string;
  /** Claude Code's transcript directory for the probe, so it can clean up after itself. */
  probeTranscriptDir?: string;
  /**
   * Run `/usage` first. What the button asks for: the timer already keeps the
   * cached figure current, so a button that re-read the cache would appear to do
   * nothing. The cache is still the answer when the command cannot run.
   */
  preferCommand?: boolean;
};

/**
 * Reads plan limits.
 *
 * By default the cache in Claude Code's state file comes first: free and
 * instant, though only as fresh as the last `/usage` run. Running `/usage` costs no
 * tokens but spawns a process and lets Claude Code refresh the figure, so it is
 * the first move only when a person asked for it (`preferCommand`), and the
 * fallback otherwise.
 */
export const readPlanUsage = async (
  options: ReadPlanUsageOptions,
  now = new Date(),
): Promise<PlanReading> => {
  const fromCache = (): PlanReading | undefined => {
    const cached = readCachedUsageFile(options.statePath, now);
    if (!cached.ok) return undefined;
    return {
      ok: true,
      usage: cached.reading.usage,
      // The age shown on the board is the age of the figure, not of our read of
      // it. Stamping this with "now" would make an hour-old number look live.
      at: cached.reading.fetchedAt,
      via: 'cache',
      drift: [],
      fetchedAtMs: cached.reading.fetchedAtMs,
    };
  };

  const fromCommand = async (): Promise<PlanReading> => {
    const probed = await probePlanUsage(
      {
        cwd: options.probeCwd,
        ...(options.probeTranscriptDir ? { transcriptDir: options.probeTranscriptDir } : {}),
      },
      now,
    );
    if (!probed.ok) return { ok: false, reason: probed.reason };
    return {
      ok: true,
      usage: probed.usage,
      at: now.toISOString(),
      via: 'command',
      drift: probed.drift,
    };
  };

  if (options.preferCommand) {
    const commanded = await fromCommand();
    // A command that spent tokens is reported, never papered over with the
    // cache: the automatic reading has to hear about it to stop.
    if (!commanded.ok && commanded.reason === 'not-local') return commanded;
    return commanded.ok ? commanded : (fromCache() ?? commanded);
  }
  return fromCache() ?? fromCommand();
};
