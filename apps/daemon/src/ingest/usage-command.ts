import { execFile } from 'node:child_process';
import { mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MAIN_AGENT_ID, type DraftEvent, type PlanUsage } from '@mirante/shared';

const run = promisify(execFile);

/**
 * Reads plan limits from Claude Code's own `/usage` command.
 *
 * Why this exists: plan limits reach the status line, and the status line runs
 * only in the terminal interface. Someone working entirely in the VS Code
 * extension never produces a single reading — measured here as 2403 events and
 * zero limits over a full day. See docs/EVENT_MAP.md §7.
 *
 * `/usage` is a *local* command: measured at `total_cost_usd: 0` and
 * `duration_api_ms: 0`, it spends no tokens and makes no model call. Mirante
 * still never reads a credential and never calls api.anthropic.com itself — it
 * runs the command the user could type, and only when the user asks. See
 * ADR-0006.
 *
 * The output is prose on an undocumented surface, so everything below is a
 * versioned adapter: it recognizes what it knows, reports what it does not as
 * drift, and degrades to "unknown" rather than to a wrong number.
 */
export const USAGE_ADAPTER_VERSION = 1;

/** Fixed arguments. Nothing user-supplied is ever interpolated into this list. */
const USAGE_ARGS = [
  '-p',
  '/usage',
  '--output-format',
  'json',
  // Skips the user's settings.json, so Mirante's own hooks do not fire for this
  // invocation. Without it, every refresh posts a SessionStart and leaves a
  // phantom lane on the board — observed, five times, while validating this.
  '--setting-sources',
  'project',
] as const;

export type ParsedUsage = {
  usage: PlanUsage;
  /**
   * Window labels the adapter did not recognize, verbatim. A new plan tier or a
   * reworded line shows up here instead of silently going missing.
   */
  drift: string[];
};

export type UsageProbe =
  ({ ok: true } & ParsedUsage) | { ok: false; reason: UsageProbeFailure; detail: string };

export type UsageProbeFailure =
  | 'claude-not-found'
  | 'command-failed'
  | 'unexpected-output'
  | 'no-plan-data'
  /**
   * `/usage` was answered by the model instead of locally, so it cost tokens.
   * Distinct from other failures because it must stop the automatic reading.
   */
  | 'not-local';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

type ZoneParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const zoneParts = (timeZone: string, epochMs: number): ZoneParts | undefined => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(epochMs));

    const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    const out = {
      year: read('year'),
      month: read('month'),
      day: read('day'),
      hour: read('hour'),
      minute: read('minute'),
      second: read('second'),
    };
    return Object.values(out).every(Number.isFinite) ? out : undefined;
  } catch {
    // An unknown IANA zone name throws rather than returning a default.
    return undefined;
  }
};

/**
 * Epoch seconds for a wall-clock reading in a named zone.
 *
 * Two passes settle the offset, because the offset itself depends on the instant
 * being resolved. The round-trip check at the end is what rejects a wall-clock
 * time that a daylight-saving jump skipped entirely.
 */
const zonedEpochSeconds = (
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number | undefined => {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let epochMs = naive;

  for (let pass = 0; pass < 2; pass += 1) {
    const seen = zoneParts(timeZone, epochMs);
    if (!seen) return undefined;
    const asUtc = Date.UTC(
      seen.year,
      seen.month - 1,
      seen.day,
      seen.hour,
      seen.minute,
      seen.second,
    );
    epochMs = naive - (asUtc - epochMs);
  }

  const check = zoneParts(timeZone, epochMs);
  if (
    !check ||
    check.year !== year ||
    check.month !== month ||
    check.day !== day ||
    check.hour !== hour ||
    check.minute !== minute
  ) {
    return undefined;
  }
  return Math.floor(epochMs / 1000);
};

/** `Sep 20, 10pm (America/Sao_Paulo)` — the year is not printed. */
const RESET_PATTERN =
  /^([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;

/**
 * Resolves a printed reset time to epoch seconds.
 *
 * The year is absent from the output, so it is inferred: a reset is in the near
 * future, which picks exactly one candidate across a year boundary.
 */
export const parseResetTime = (text: string, now: Date): number | undefined => {
  const match = RESET_PATTERN.exec(text.trim());
  if (!match) return undefined;

  const [, monthName, dayText, hourText, minuteText, meridiem, timeZone] = match;
  // Every group but the minutes is required by the pattern; the compiler cannot
  // see that, and a guard is cheaper than asserting it away.
  if (!monthName || !dayText || !hourText || !meridiem || !timeZone) return undefined;
  const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase()) + 1;
  if (month === 0) return undefined;

  const day = Number(dayText);
  const hour12 = Number(hourText);
  if (hour12 < 1 || hour12 > 12) return undefined;
  const hour = (hour12 % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  const minute = minuteText === undefined ? 0 : Number(minuteText);

  const here = zoneParts(timeZone, now.getTime());
  if (!here) return undefined;

  const candidates = [here.year - 1, here.year, here.year + 1]
    .map((year) => zonedEpochSeconds(timeZone, year, month, day, hour, minute))
    .filter((epoch): epoch is number => epoch !== undefined);

  // A window resets ahead of now. A little slack absorbs the seconds between the
  // command running and this parse, and a reset that has just elapsed.
  const floor = Math.floor(now.getTime() / 1000) - 3600;
  const ahead = candidates.filter((epoch) => epoch >= floor).sort((a, b) => a - b);
  return ahead[0];
};

const WINDOW_PATTERNS: [keyof PlanUsage, RegExp][] = [
  ['fiveHour', /^current session:\s*([\d.]+)%\s*used/i],
  ['sevenDay', /^current week \(all models\):\s*([\d.]+)%\s*used/i],
];

/** Any line shaped like a window, so an unrecognized one can be reported. */
const ANY_WINDOW = /^current\s+[^:]+:\s*[\d.]+%\s*used/i;

/**
 * Turns the printed report into plan windows.
 *
 * Pure: takes the text, returns the reading. Everything that touches a process
 * lives in `probePlanUsage`.
 */
export const parseUsageOutput = (report: string, now: Date): ParsedUsage => {
  const usage: PlanUsage = {};
  const drift: string[] = [];

  for (const line of report.split('\n').map((entry) => entry.trim())) {
    if (!ANY_WINDOW.test(line)) continue;

    const matched = WINDOW_PATTERNS.find(([, pattern]) => pattern.test(line));
    if (!matched) {
      drift.push(line);
      continue;
    }

    const [key, pattern] = matched;
    const percentage = Number(pattern.exec(line)?.[1]);
    if (!Number.isFinite(percentage)) {
      drift.push(line);
      continue;
    }

    const resetText = line
      .split('·')
      .slice(1)
      .join('·')
      .replace(/^\s*resets\s*/i, '');
    const resetsAt = resetText ? parseResetTime(resetText, now) : undefined;

    usage[key] = {
      usedPercentage: percentage,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    };
  }

  return { usage, drift };
};

export type ProbeOptions = {
  /** Where the probe runs. Kept outside any project so no project settings load. */
  cwd: string;
  /**
   * Claude Code's transcript directory for `cwd`. When given, the probe removes
   * the one transcript it caused — otherwise every "Read now" leaves a file in
   * the person's Claude Code history for a session they never ran.
   */
  transcriptDir?: string;
  binary?: string;
  timeoutMs?: number;
};

/**
 * Runs `/usage` and returns the plan windows it reported.
 *
 * Never throws: every failure is a typed reason the interface can state plainly.
 */
export const probePlanUsage = async (
  options: ProbeOptions,
  now = new Date(),
): Promise<UsageProbe> => {
  const binary = options.binary ?? process.env.MIRANTE_CLAUDE_BIN ?? 'claude';

  try {
    mkdirSync(options.cwd, { recursive: true });
  } catch (error) {
    return { ok: false, reason: 'command-failed', detail: String(error) };
  }

  let stdout: string;
  try {
    const result = await run(binary, [...USAGE_ARGS], {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 45_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        // Belt and braces alongside --setting-sources: a hook that ever gains a
        // script form can check this and stay silent.
        MIRANTE_INTERNAL: '1',
      },
    });
    stdout = result.stdout;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, reason: 'claude-not-found', detail: binary };
    }
    return { ok: false, reason: 'command-failed', detail: code ?? 'exited non-zero' };
  }

  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: 'unexpected-output', detail: 'not JSON' };
  }

  const envelope = report as {
    result?: unknown;
    local_command?: unknown;
    is_error?: unknown;
    session_id?: unknown;
  };
  // Only a file named exactly for this probe's session, in the probe's own
  // directory. Anything that does not look like a session id is left alone.
  if (
    options.transcriptDir &&
    typeof envelope.session_id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(envelope.session_id)
  ) {
    try {
      unlinkSync(join(options.transcriptDir, `${envelope.session_id}.jsonl`));
    } catch {
      // Not written yet, or already gone. Nothing to undo either way.
    }
  }
  if (envelope.is_error === true || typeof envelope.result !== 'string') {
    return { ok: false, reason: 'unexpected-output', detail: 'no result text' };
  }
  if (envelope.local_command !== 'usage') {
    // The slash command was not handled locally, which means this invocation
    // would have cost tokens. Refuse to normalize whatever came back.
    return { ok: false, reason: 'not-local', detail: 'not handled as a local command' };
  }

  const parsed = parseUsageOutput(envelope.result, now);
  if (Object.keys(parsed.usage).length === 0) {
    // An API-key user, or a reworded report. Either way there is no reading, and
    // an empty object would render as zero rather than as unknown.
    return { ok: false, reason: 'no-plan-data', detail: parsed.drift.join(' | ') };
  }
  return { ok: true, ...parsed };
};

/**
 * The event a successful probe appends.
 *
 * Plan limits are per account, so the session and project fields carry no
 * meaning here; the board folds this at its own level.
 */
export const usageProbeToEvent = (
  usage: PlanUsage,
  at = new Date().toISOString(),
  from: { source: 'usage-command' | 'usage-cache'; dedupeKey?: string } = {
    source: 'usage-command',
  },
): DraftEvent => ({
  ts: at,
  source: from.source,
  ...(from.dedupeKey === undefined ? {} : { dedupeKey: from.dedupeKey }),
  sessionId: 'mirante:usage-probe',
  projectPath: '',
  agentId: MAIN_AGENT_ID,
  kind: 'plan.usage.updated',
  payload: { usage },
});
