import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { MiranteEvent } from '@mirante/shared';
import type { EventLog } from '../../core/eventlog.js';
import { signatureOf } from '../transcript/watcher.js';
import { createThreadState, parseRolloutLines, type CodexThreadState } from './parse.js';

export type CodexWatcherOptions = {
  /** `$CODEX_HOME/sessions`. Only `rollout-*.jsonl` files under it are ever opened. */
  sessionsDir: string;
  log: EventLog;
  onEvents: (events: MiranteEvent[]) => void;
  pollIntervalMs?: number;
  /** Threads untouched for longer than this are not read. Browsable history is M2. */
  maxAgeMs?: number;
  /**
   * Bytes read per pass, across every file. A Codex root runs to tens of
   * megabytes; read in one go on the first pass, it would hold the daemon —
   * and every hook waiting on it — for seconds. Spread over passes, the board
   * fills in while the daemon keeps answering.
   */
  readBudgetBytes?: number;
  onWarning?: (message: string) => void;
};

const DEFAULT_POLL_MS = 1_500;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_READ_BUDGET = 32 * 1024 * 1024;
const NEWLINE = 0x0a;

/** One rollout file being followed: where reading stopped, and what the reader knew there. */
type Tail = {
  ino: number;
  offset: number;
  /** Bytes after the last complete line. A line is only parsed once it ends. */
  partial: Buffer;
  /** Whether the first line — who the thread is — has been read. It is always parsed. */
  identified: boolean;
  state: CodexThreadState;
};

/**
 * Records the reader never looks at, recognised by the head of the line so the
 * largest of them — encrypted reasoning, the context Codex injects into every
 * turn — are never parsed at all. Anything whose head does not match is parsed; this is a
 * shortcut, never a filter the reader depends on.
 */
const SKIPPED = new Set([
  'response_item/reasoning',
  'response_item/message',
  'response_item/agent_message',
  'response_item/compaction',
  'event_msg/sub_agent_activity',
  'event_msg/web_search_end',
  'event_msg/patch_apply_end',
  'event_msg/thread_settings_applied',
  'event_msg/mcp_tool_call_end',
  'event_msg/image_generation_end',
  'world_state/',
  'compacted/',
  'inter_agent_communication_metadata/',
]);

const HEAD = /"type":"([a-z_]+)"(?:,"payload":\{"type":"([A-Za-z_]+)")?/;

const worthParsing = (line: string): boolean => {
  const match = HEAD.exec(line.slice(0, 200));
  if (!match) return true;
  return !SKIPPED.has(`${match[1] ?? ''}/${match[2] ?? ''}`);
};

const safeStat = (path: string) => {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
};

const safeReaddir = (path: string): string[] => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

/**
 * Every rollout file under `YYYY/MM/DD/`, oldest name first.
 *
 * A thread lives in the directory of the day it started, and a long session
 * keeps writing to a directory weeks old — so every day is listed and the age
 * cut is made by modification time. The name carries the start time, so
 * sorting by it reads a root before the subagents it spawned.
 */
export const locateRollouts = (sessionsDir: string): string[] => {
  const files: string[] = [];
  for (const year of safeReaddir(sessionsDir)) {
    if (!/^\d{4}$/.test(year)) continue;
    for (const month of safeReaddir(join(sessionsDir, year))) {
      for (const day of safeReaddir(join(sessionsDir, year, month))) {
        const dir = join(sessionsDir, year, month, day);
        for (const entry of safeReaddir(dir)) {
          if (entry.startsWith('rollout-') && entry.endsWith('.jsonl'))
            files.push(join(dir, entry));
        }
      }
    }
  }
  return files.sort((a, b) => basename(a).localeCompare(basename(b)));
};

/**
 * Follows OpenAI Codex rollout files and turns what is appended into events.
 *
 * Unlike the Claude Code watcher, which re-reads a changed session whole, this
 * tails each file from where it stopped: Codex files are too large to re-read
 * every second, and a Codex thread's parent edge is in its own first line, so
 * nothing needs another file to be understood. See ADR-0008.
 *
 * It opens rollout files and nothing else. `auth.json` sits one directory up
 * and is never touched.
 */
export class CodexWatcher {
  private readonly options: Required<Omit<CodexWatcherOptions, 'onWarning'>> &
    Pick<CodexWatcherOptions, 'onWarning'>;
  private readonly tails = new Map<string, Tail>();
  /** sessionId → event signatures already in the log, so a restart appends nothing twice. */
  private readonly emitted = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;

  constructor(options: CodexWatcherOptions) {
    this.options = {
      pollIntervalMs: DEFAULT_POLL_MS,
      maxAgeMs: DEFAULT_MAX_AGE_MS,
      readBudgetBytes: DEFAULT_READ_BUDGET,
      ...options,
    };
  }

  /**
   * Offsets are not persisted, so a restart reads each live file again from
   * the top. What the log already holds is skipped by signature.
   */
  reindexFromLog(): void {
    for (const event of this.options.log.replay()) {
      if (event.source !== 'codex-rollout') continue;
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
      const cutoff = Date.now() - this.options.maxAgeMs;
      let budget = this.options.readBudgetBytes;
      let appended = 0;
      for (const path of locateRollouts(this.options.sessionsDir)) {
        if (budget <= 0) break;
        const stat = safeStat(path);
        if (!stat) continue;
        let tail = this.tails.get(path);
        // Old history is not read — unless this watcher already follows the
        // file, whose next line would otherwise be lost.
        if (!tail && stat.mtimeMs < cutoff) continue;
        // Replaced or truncated: start over. Signatures keep the log clean.
        if (!tail || tail.ino !== stat.ino || stat.size < tail.offset) {
          tail = {
            ino: stat.ino,
            offset: 0,
            partial: Buffer.alloc(0),
            identified: false,
            state: createThreadState(),
          };
          this.tails.set(path, tail);
        }
        if (stat.size === tail.offset) continue;
        const want = Math.min(stat.size - tail.offset, budget);
        budget -= want;
        appended += this.readInto(path, tail, want);
      }
      return appended;
    } finally {
      this.scanning = false;
    }
  }

  private readInto(path: string, tail: Tail, length: number): number {
    const chunk = Buffer.alloc(length);
    let read: number;
    let fd: number | undefined;
    try {
      fd = openSync(path, 'r');
      read = readSync(fd, chunk, 0, length, tail.offset);
    } catch {
      return 0;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    tail.offset += read;

    // Split on the byte, not the character: a chunk can end inside a UTF-8
    // sequence, and only a complete line is ever decoded.
    const data =
      tail.partial.length > 0
        ? Buffer.concat([tail.partial, chunk.subarray(0, read)])
        : chunk.subarray(0, read);
    const end = data.lastIndexOf(NEWLINE);
    if (end < 0) {
      tail.partial = Buffer.from(data);
      return 0;
    }
    tail.partial = Buffer.from(data.subarray(end + 1));

    const records: unknown[] = [];
    for (const line of data.subarray(0, end).toString('utf8').split('\n')) {
      if (line.length === 0) continue;
      // The first line is who the thread is; everything depends on it.
      if (tail.identified && !worthParsing(line)) continue;
      tail.identified = true;
      try {
        records.push(JSON.parse(line));
      } catch {
        this.options.onWarning?.(`${basename(path)}: unreadable rollout line`);
      }
    }

    const { events, warnings } = parseRolloutLines(tail.state, records);
    for (const warning of warnings) this.options.onWarning?.(`${basename(path)}: ${warning}`);
    if (events.length === 0) return 0;

    const seen = this.seen(tail.state.sessionId);
    const fresh = events.filter((event) => !seen.has(signatureOf(event)));
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
