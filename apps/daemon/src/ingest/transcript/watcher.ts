import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { REREADABLE_KINDS, type DraftEvent, type MiranteEvent } from '@mirante/shared';
import type { EventLog } from '../../core/eventlog.js';
import { locateSessions, sessionSignature, type LocatedSession } from './locate.js';
import { parseSessionTranscript } from './parse.js';
import { MarkdownPlanFiles } from './plan-files.js';

/**
 * A stable identity for an event, used to tell what a re-parse already emitted.
 *
 * Most events carry a dedupeKey; the rest are identified by their content. The
 * timestamp is part of it because the same kind of thing can legitimately happen
 * twice to the same card.
 */
const contentHash = (event: DraftEvent): string =>
  createHash('sha1').update(JSON.stringify(event.payload)).digest('hex').slice(0, 12);

export const signatureOf = (event: DraftEvent): string =>
  // A re-readable fact is identified by what it says, not only by which fact it
  // is: the transcript is re-read whole, and a parser that learns to read a new
  // field has something to add about a call already in the log. Everything else
  // keeps its key, so an unchanged re-read appends nothing.
  REREADABLE_KINDS.has(event.kind)
    ? `${event.dedupeKey ?? `${event.kind}|${event.agentId}|${event.ts}`}|${event.kind === 'usage.updated' ? event.ts : ''}|${contentHash(event)}`
    : (event.dedupeKey ?? `${event.kind}|${event.agentId}|${event.ts}|${contentHash(event)}`);

export type WatcherOptions = {
  projectsDir: string;
  log: EventLog;
  onEvents: (events: MiranteEvent[]) => void;
  /** How often to look for changes. Hooks carry the real-time path; this is the safety net. */
  pollIntervalMs?: number;
  /** How far back to consider a session live. Browsable history is M2. */
  maxAgeMs?: number;
  /** Repair already-observed history without importing unrelated old sessions. */
  knownSessionIds?: ReadonlySet<string>;
  /** Project directories to skip, by slug. Mirante's own probe lives in one. */
  ignoreSlugs?: ReadonlySet<string>;
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
  private readonly historicalStarts = new Set<string>();
  private readonly historicalFinishes = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;
  private readonly planFiles = new MarkdownPlanFiles();
  /** Hook-only closes must constrain file following, including after a restart. */
  private readonly hookLifecycle = new Map<string, Map<number, MiranteEvent>>();
  private lifecycleLogId = 0;

  constructor(options: WatcherOptions) {
    this.options = {
      pollIntervalMs: DEFAULT_POLL_MS,
      maxAgeMs: DEFAULT_MAX_AGE_MS,
      knownSessionIds: new Set<string>(),
      ignoreSlugs: new Set<string>(),
      ...options,
    };
  }

  /**
   * Teaches the watcher what the log already contains, so a restart resumes
   * instead of re-emitting every session from the beginning.
   */
  reindexFromLog(): void {
    for (const event of this.options.log.replay()) {
      this.rememberHookLifecycle(event);
      this.lifecycleLogId = event.id;
      if (event.kind === 'task.plan.updated') this.planFiles.restore(event);
      if (event.kind === 'agent.started' && event.dedupeKey)
        this.historicalStarts.add(`${event.sessionId}|${event.dedupeKey}`);
      if (event.kind === 'agent.finished' && event.dedupeKey)
        this.historicalFinishes.add(`${event.sessionId}|${event.dedupeKey}`);
      if (event.source !== 'transcript' && event.source !== 'plan-file') continue;
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
      // Read only arrivals since the previous pass. These events already exist
      // in the log and must not be appended again as transcript observations.
      for (const event of this.options.log.replay(this.lifecycleLogId)) {
        this.rememberHookLifecycle(event);
        this.lifecycleLogId = event.id;
      }
      let appended = 0;
      const sessionIds = new Set<string>();
      for (const session of locateSessions(
        this.options.projectsDir,
        this.options.maxAgeMs,
        this.options.ignoreSlugs,
        this.options.knownSessionIds,
      )) {
        sessionIds.add(session.sessionId);
        appended += this.scanSession(session);
        const seen = this.seen(session.sessionId);
        const plans = this.planFiles
          .read(session.sessionId)
          .filter((event) => !seen.has(signatureOf(event)));
        if (plans.length) {
          for (const event of plans) seen.add(signatureOf(event));
          const events = this.options.log.appendMany(plans);
          this.options.onEvents(events);
          appended += events.length;
        }
      }
      this.planFiles.forgetExcept(sessionIds);
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
    const historical = session.lastModifiedMs < Date.now() - this.options.maxAgeMs;
    const lifecycle = this.hookLifecycle.get(session.sessionId);
    const planContext = lifecycle
      ? [...lifecycle.values(), ...parsed.events].sort((a, b) => a.ts.localeCompare(b.ts))
      : parsed.events;
    this.planFiles.remember(session.sessionId, planContext, historical);
    const fresh = parsed.events.filter(
      (event) =>
        !seen.has(signatureOf(event)) &&
        (!historical ||
          event.kind === 'agent.instruction' ||
          event.kind === 'usage.updated' ||
          event.kind === 'task.plan.updated' ||
          (event.kind === 'agent.finished' &&
            this.historicalFinishes.has(`${event.sessionId}|${event.dedupeKey ?? ''}`)) ||
          (event.kind === 'agent.started' &&
            this.historicalStarts.has(`${event.sessionId}|${event.dedupeKey ?? ''}`))),
    );
    if (fresh.length === 0) return 0;

    for (const event of fresh) seen.add(signatureOf(event));
    const appended = this.options.log.appendMany(fresh);
    this.options.onEvents(appended);
    return appended.length;
  }

  private rememberHookLifecycle(event: MiranteEvent): void {
    if (
      event.source !== 'hook' ||
      !['session.started', 'session.ended', 'agent.started', 'agent.finished'].includes(event.kind)
    )
      return;
    const events = this.hookLifecycle.get(event.sessionId) ?? new Map<number, MiranteEvent>();
    if (events.has(event.id)) return;
    events.set(event.id, event);
    this.hookLifecycle.set(event.sessionId, events);
    this.signatures.delete(event.sessionId);
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
