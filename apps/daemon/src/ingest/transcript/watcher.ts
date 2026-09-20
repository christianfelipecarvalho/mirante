import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DraftEvent, MiranteEvent } from '@mirante/shared';
import type { EventLog } from '../../core/eventlog.js';
import { locateSessions, sessionSignature, type LocatedSession } from './locate.js';
import { parseSessionTranscript } from './parse.js';

/**
 * A stable identity for an event, used to tell what a re-parse already emitted.
 *
 * Most events carry a dedupeKey; the rest are identified by their content. The
 * timestamp is part of it because the same kind of thing can legitimately happen
 * twice to the same card.
 */
const signatureOf = (event: DraftEvent): string =>
  event.dedupeKey ??
  `${event.kind}|${event.agentId}|${event.ts}|${createHash('sha1')
    .update(JSON.stringify(event.payload))
    .digest('hex')
    .slice(0, 12)}`;

export type WatcherOptions = {
  projectsDir: string;
  log: EventLog;
  onEvents: (events: MiranteEvent[]) => void;
  /** How often to look for changes. Hooks carry the real-time path; this is the safety net. */
  pollIntervalMs?: number;
  /** How far back to consider a session live. Browsable history is M2. */
  maxAgeMs?: number;
  onWarning?: (message: string) => void;
};

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Watches Claude Code transcripts and turns changes into events.
 *
 * When a session's files change, the whole session is re-parsed and only
 * genuinely new events are appended. Incremental parsing would be faster, but a
 * subagent's parent link lives in a different file than the subagent's own
 * turns, so partial context produces wrong answers — and a session changes at
 * human speed, so there is nothing to win.
 */
export class TranscriptWatcher {
  private readonly options: Required<Omit<WatcherOptions, 'onWarning'>> &
    Pick<WatcherOptions, 'onWarning'>;
  /** sessionId → the file signature last parsed, so unchanged sessions are skipped. */
  private readonly signatures = new Map<string, string>();
  /** sessionId → event signatures already appended. */
  private readonly emitted = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;

  constructor(options: WatcherOptions) {
    this.options = {
      pollIntervalMs: DEFAULT_POLL_MS,
      maxAgeMs: DEFAULT_MAX_AGE_MS,
      ...options,
    };
  }

  /**
   * Teaches the watcher what the log already contains, so a restart resumes
   * instead of re-emitting every session from the beginning.
   */
  reindexFromLog(): void {
    for (const event of this.options.log.since(0)) {
      if (event.source !== 'transcript') continue;
      this.seen(event.sessionId).add(signatureOf(event));
    }
  }

  start(): void {
    if (this.timer) return;
    this.scan();
    this.timer = setInterval(() => this.scan(), this.options.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass. Returns how many events were appended. */
  scan(): number {
    if (this.scanning) return 0;
    this.scanning = true;
    try {
      let appended = 0;
      for (const session of locateSessions(this.options.projectsDir, this.options.maxAgeMs)) {
        appended += this.scanSession(session);
      }
      return appended;
    } finally {
      this.scanning = false;
    }
  }

  private scanSession(session: LocatedSession): number {
    const signature = sessionSignature(session);
    if (this.signatures.get(session.sessionId) === signature) return 0;
    this.signatures.set(session.sessionId, signature);

    const parsed = parseSessionTranscript({
      mainLines: readJsonl(session.mainPath),
      subagents: session.subagents.map((sub) => ({
        agentId: sub.agentId,
        ...(sub.metaPath ? { meta: readJson(sub.metaPath) } : {}),
        lines: readJsonl(sub.transcriptPath),
      })),
    });

    for (const warning of parsed.warnings) {
      this.options.onWarning?.(`${session.sessionId}: ${warning}`);
    }
    if (parsed.skipped > 0) {
      // Entries that did not match even the lenient schema. A rising count is
      // the first sign that Claude Code changed the format under us.
      this.options.onWarning?.(
        `${session.sessionId}: ${parsed.skipped} unreadable transcript entries`,
      );
    }

    const seen = this.seen(session.sessionId);
    const fresh = parsed.events.filter((event) => !seen.has(signatureOf(event)));
    if (fresh.length === 0) return 0;

    for (const event of fresh) seen.add(signatureOf(event));
    const appended = this.options.log.appendMany(fresh);
    this.options.onEvents(appended);
    return appended.length;
  }

  private seen(sessionId: string): Set<string> {
    const existing = this.emitted.get(sessionId);
    if (existing) return existing;
    const created = new Set<string>();
    this.emitted.set(sessionId, created);
    return created;
  }
}

const readJsonl = (path: string): unknown[] => {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const lines: unknown[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch {
      // A partially written last line is normal while a session is live; it will
      // be complete on the next pass.
    }
  }
  return lines;
};

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
};
