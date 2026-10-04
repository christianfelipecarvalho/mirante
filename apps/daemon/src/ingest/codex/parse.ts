import { createHash } from 'node:crypto';
import {
  MAIN_AGENT_ID,
  reportedEffort,
  dedupeKeys,
  type DraftEvent,
  type Entrypoint,
  type PlanUsage,
} from '@mirante/shared';
import { SAID_PREVIEW_LENGTH, preview } from '../../core/redact.js';

/**
 * Reads an OpenAI Codex rollout file into the normalized event vocabulary.
 *
 * Codex writes one JSONL file per thread under `~/.codex/sessions/`. The root
 * thread is the session a person typed into; each subagent is a thread of its
 * own, whose first record names its parent. The edge is recorded, not
 * inferred — the same property ADR-0004 relies on for Claude Code.
 *
 * Pure, like the transcript reader: it takes records and returns events, and
 * performs no I/O. It is also incremental, because a Codex root file runs to
 * tens of megabytes: the caller keeps a `CodexThreadState` per file and feeds
 * it each batch of new lines. Everything the reader needs from earlier lines —
 * which turn is open, which calls are running — lives in that state.
 *
 * Mapping, divergences and the two record layouts are in docs/EVENT_MAP.md §9.
 */

type Json = Record<string, unknown>;

const isObj = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** Codex ids are UUIDv7: time-ordered, so a thread's own turns sort after its own id. */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const hash = (value: string): string => createHash('sha1').update(value).digest('hex').slice(0, 12);

/** Stable plan readings still confirm freshness, without adding a row for every response. */
const PLAN_READING_HEARTBEAT_MS = 60_000;

export type CodexThreadState = {
  /** Set once the first record has been read. Until then nothing is emitted. */
  known: boolean;
  /** Guardian threads — Codex's automatic approval reviewer — are not work anyone asked for. */
  ignored: boolean;
  threadId: string;
  /** The root thread's id: every thread of one session shares it, and it is the lane. */
  sessionId: string;
  agentId: string;
  parentAgentId?: string;
  agentType?: string;
  task?: string;
  cwd: string;
  gitBranch?: string;
  entrypoint: Entrypoint;
  cliVersion?: string;
  resumed: boolean;
  model?: string;
  /**
   * False while the file is replaying history it inherited.
   *
   * A subagent, and a forked root, open by copying their parent's history —
   * hundreds of records, including the parent's prompts and turns. Read as the
   * thread's own, every subagent would claim to have typed the person's
   * request. Own work begins at the first turn created after the thread was:
   * see `isOwnTurn`.
   */
  own: boolean;
  turnId?: string;
  /** The person's request this turn serves. For a subagent, its root's turn. */
  promptId?: string;
  /** Assignments this thread has started. The first opens the card; later ones reopen it. */
  runs: number;
  /** call_id → the tool name shown for it, while it runs. */
  openCalls: Record<string, string>;
  /** The call a waiting state belongs to, so only its answer clears it. */
  waitingOn?: string;
  /** Skills already reported in this turn. */
  skillsThisTurn: string[];
  /** Roles this thread has spawned, which is what a wait is waiting on. */
  spawnedRoles: string[];
  /**
   * The context figure last reported. Codex reports usage after every
   * response; only a change worth a digit on the lane is kept.
   */
  contextPercent?: number;
  /** The plan reading last reported, serialised, so only changes bypass the heartbeat throttle. */
  planReading?: string;
  /** Source time of the last emitted reading, so throttling is deterministic across replay. */
  planReadingEmittedAtMs?: number;
};

export const createThreadState = (): CodexThreadState => ({
  known: false,
  ignored: false,
  threadId: '',
  sessionId: '',
  agentId: MAIN_AGENT_ID,
  cwd: '',
  entrypoint: 'unknown',
  resumed: false,
  own: true,
  runs: 0,
  openCalls: {},
  skillsThisTurn: [],
  spawnedRoles: [],
});

/** Where Codex says the session was launched from. */
export const codexEntrypoint = (source: unknown, originator: unknown): Entrypoint => {
  const raw = `${typeof source === 'string' ? source : ''} ${typeof originator === 'string' ? originator : ''}`;
  if (/vscode/.test(raw)) return 'vscode';
  if (/\bexec\b|codex_exec/.test(raw)) return 'print';
  if (/\bcli\b|codex_cli/.test(raw)) return 'cli';
  return 'unknown';
};

/** `/root/template_dba_final` → `template dba final`: the task the parent named. */
const taskFromPath = (path: string | undefined): string | undefined => {
  const last = path?.split('/').filter(Boolean).at(-1);
  return last && last !== 'root' ? last.replace(/[_-]+/g, ' ').trim() : undefined;
};

const isOwnTurn = (state: CodexThreadState, turnId: string | undefined): boolean =>
  turnId !== undefined && UUID_V7.test(turnId) && turnId >= state.threadId;

/**
 * Learns who this thread is from its first record.
 *
 * `session_id` is the root's id even in a subagent's file, which is what folds
 * a whole team of Codex agents into one lane.
 */
const identify = (state: CodexThreadState, meta: Json): void => {
  state.known = true;
  state.threadId = str(meta.id) ?? '';
  state.sessionId = str(meta.session_id) ?? state.threadId;
  state.cwd = str(meta.cwd) ?? '';
  state.cliVersion = str(meta.cli_version);
  state.entrypoint = codexEntrypoint(meta.source, meta.originator);
  const git = isObj(meta.git) ? meta.git : undefined;
  const branch = str(git?.branch);
  if (branch) state.gitBranch = branch;

  const source = isObj(meta.source) ? meta.source : undefined;
  const subagent = source && isObj(source.subagent) ? source.subagent : undefined;
  if (subagent && subagent.other === 'guardian') {
    state.ignored = true;
    return;
  }
  const spawn = subagent && isObj(subagent.thread_spawn) ? subagent.thread_spawn : undefined;
  const parent = str(meta.parent_thread_id) ?? str(spawn?.parent_thread_id);
  const isSubagent = meta.thread_source === 'subagent' || subagent !== undefined;

  if (isSubagent) {
    state.agentId = state.threadId;
    state.parentAgentId = !parent || parent === state.sessionId ? MAIN_AGENT_ID : parent;
    state.agentType = str(meta.agent_role) ?? str(spawn?.agent_role) ?? 'default';
    const task = taskFromPath(str(meta.agent_path) ?? str(spawn?.agent_path));
    if (task) state.task = task;
  }
  // A forked thread opens with its parent's history; its own starts later.
  state.resumed = !isSubagent && str(meta.forked_from_id) !== undefined;
  state.own = !isSubagent && !state.resumed;
};

/**
 * The first shell command in a call: a code-mode `exec` script (`cmd: "…"`),
 * `exec_command` arguments (`{"cmd": "…"}`), or the older `shell` tool's argv.
 */
const commandIn = (text: string): string | undefined => {
  try {
    const args: unknown = JSON.parse(text);
    if (isObj(args)) {
      if (typeof args.cmd === 'string') return args.cmd;
      if (Array.isArray(args.command)) return args.command.map(String).at(-1);
    }
  } catch {
    // Not JSON: a script.
  }
  const match =
    /\bcmd"?\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text) ?? /\bcmd\s*:\s*'((?:[^'\\]|\\.)*)'/.exec(text);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(`"${match[1].replace(/\\'/g, "'")}"`) as string;
  } catch {
    return match[1];
  }
};

/** Codex's tools, named in the board's vocabulary so the interface needs no second one. */
const TOOL_NAMES: Record<string, string> = {
  exec_command: 'Bash',
  shell: 'Bash',
  write_stdin: 'Bash',
  apply_patch: 'Edit',
  view_image: 'Read',
  web__run: 'WebSearch',
  web_search: 'WebSearch',
  update_plan: 'TodoWrite',
};

/** What a code-mode script mostly does. It can call several tools; the first that is not a shell wins. */
const scriptTool = (script: string): string => {
  const called = [...script.matchAll(/tools\.(\w+)\s*\(/g)].map((m) => m[1] ?? '');
  const notShell = called.find((name) => name !== 'exec_command' && name !== 'write_stdin');
  return TOOL_NAMES[notShell ?? called[0] ?? 'exec_command'] ?? notShell ?? 'Bash';
};

const patchedFiles = (text: string): string[] =>
  // Inside a script the patch is a string literal, its newlines escaped.
  [...text.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n\\`"]+)/g)].map((m) =>
    (m[1] ?? '').trim(),
  );

const summaryOf = (tool: string, text: string): string => {
  if (tool === 'Edit') {
    const files = patchedFiles(text);
    if (files.length > 0) return preview(files.join(', '));
  }
  const command = commandIn(text);
  if (command) return preview(command);
  const path = /\bpath"?\s*:\s*"([^"]+)"/.exec(text)?.[1];
  if (path) return preview(path);
  // Never the script itself: it is code, often long, and says less than its first command.
  return '';
};

/** Every skill a command reads. Codex has no skill call — reading its SKILL.md is how one is used. */
const skillsIn = (text: string): string[] => [
  ...new Set([...text.matchAll(/skills\/([\w.-]+)\/SKILL\.md/g)].map((m) => m[1] ?? '')),
];

const outputText = (output: unknown): string => {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const first = output.find((part) => isObj(part) && typeof part.text === 'string');
    return isObj(first) ? String(first.text) : '';
  }
  return '';
};

const failed = (text: string): string | undefined => {
  const head = text.trimStart();
  if (/^Script failed/.test(head) || /^collab tool failed/.test(head)) {
    // The first line that says what went wrong, not the wrapper's bookkeeping.
    return (
      head
        .split('\n')
        .find(
          (line) => line.trim().length > 0 && !/^(Script failed|Wall time|Output:)/.test(line),
        ) ?? head
    );
  }
  const exit = /Process exited with code (\d+)/.exec(head);
  if (exit && exit[1] !== '0') return head;
  return undefined;
};

const messageText = (item: Json): string => {
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .map((part) => (isObj(part) && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
};

/**
 * Codex's plan windows, named by the board's keys.
 *
 * Codex does not name its windows; it sizes them. The two sizes seen on disk
 * are 300 minutes (the "plus" plan's short window) and 10,080 minutes (a
 * week). A window of any other size is left out rather than guessed at: a
 * meter under the wrong name is worse than no meter. See docs/EVENT_MAP.md §9.
 */
const WINDOW_BY_MINUTES: Record<number, 'fiveHour' | 'sevenDay'> = {
  300: 'fiveHour',
  10080: 'sevenDay',
};

/** A Codex `rate_limits` object, in the board's plan shape. Undefined when it says nothing usable. */
export const codexPlanUsage = (limits: unknown): PlanUsage | undefined => {
  if (!isObj(limits)) return undefined;
  const usage: PlanUsage = {};
  for (const slot of [limits.primary, limits.secondary]) {
    if (!isObj(slot) || typeof slot.used_percent !== 'number') continue;
    const key =
      typeof slot.window_minutes === 'number' ? WINDOW_BY_MINUTES[slot.window_minutes] : undefined;
    if (!key) continue;
    usage[key] = {
      usedPercentage: Math.max(0, slot.used_percent),
      ...(typeof slot.resets_at === 'number' && slot.resets_at > 0
        ? { resetsAt: Math.floor(slot.resets_at) }
        : {}),
    };
  }
  return usage.fiveHour || usage.sevenDay ? usage : undefined;
};

export type CodexParseResult = { events: DraftEvent[]; warnings: string[] };

/**
 * Turns the next batch of a thread's records into events.
 *
 * `lines` are the records appended since the last call, in file order. The
 * state is updated in place and is the only thing carried between calls.
 */
export const parseRolloutLines = (
  state: CodexThreadState,
  lines: readonly unknown[],
): CodexParseResult => {
  const events: DraftEvent[] = [];
  const warnings: string[] = [];

  for (const line of lines) {
    if (!isObj(line)) continue;
    const payload = isObj(line.payload) ? line.payload : {};
    const type = str(line.type);
    const ts = str(line.timestamp) ?? new Date(0).toISOString();

    if (!state.known) {
      if (type !== 'session_meta') {
        warnings.push('rollout does not open with session_meta');
        state.known = true;
        state.ignored = true;
        continue;
      }
      identify(state, payload);
      if (state.ignored) continue;
      // Every thread declares its session, under the one key they share. The
      // root's file sorts first, so its declaration is the one kept; a
      // subagent's matters only when the root is too old to be read, and then
      // it is what keeps the lane from being taken for Claude Code's.
      {
        events.push({
          ts: str(payload.timestamp) ?? ts,
          source: 'codex-rollout',
          sessionId: state.sessionId,
          projectPath: state.cwd,
          ...(state.gitBranch ? { gitBranch: state.gitBranch } : {}),
          agentId: MAIN_AGENT_ID,
          kind: 'session.started',
          dedupeKey: dedupeKeys.sessionStarted(state.sessionId),
          payload: {
            entrypoint: state.entrypoint,
            cwd: state.cwd,
            harness: 'codex',
            ...(state.cliVersion ? { harnessVersion: state.cliVersion } : {}),
            ...(state.resumed ? { resumed: true } : {}),
          },
        });
      }
      continue;
    }
    if (state.ignored) continue;

    const kind = str(payload.type);

    // The turn boundary decides everything else: whether what follows is
    // replayed history or this thread's own work.
    if (type === 'event_msg' && kind === 'task_started') {
      const turnId = str(payload.turn_id);
      if (!state.own) {
        if (!isOwnTurn(state, turnId)) continue;
        state.own = true;
      }
      state.turnId = turnId;
      state.promptId = str(payload.root_turn_id) ?? turnId;
      state.skillsThisTurn = [];
      state.openCalls = {};
      delete state.waitingOn;
    }
    if (!state.own) continue;

    const base = {
      ts,
      source: 'codex-rollout' as const,
      sessionId: state.sessionId,
      projectPath: state.cwd,
      ...(state.gitBranch ? { gitBranch: state.gitBranch } : {}),
      agentId: state.agentId,
      ...(state.agentType ? { agentType: state.agentType } : {}),
      ...(state.parentAgentId ? { parentAgentId: state.parentAgentId } : {}),
      ...(state.promptId ? { promptId: state.promptId } : {}),
    };
    const isMain = state.agentId === MAIN_AGENT_ID;

    if (type === 'turn_context') {
      const model = str(payload.model);
      if (model) state.model = model;
      const effort = reportedEffort(payload.effort);
      events.push({
        ...base,
        kind: 'agent.metadata.updated',
        dedupeKey: `agent.metadata.updated:${state.threadId}:${str(payload.turn_id) ?? ''}:${ts}:${hash(JSON.stringify({ model, effort: effort ?? null }))}`,
        payload: { ...(model ? { model } : {}), effort: effort ?? null },
      });
      const cwd = str(payload.cwd);
      if (cwd) state.cwd = cwd;
      continue;
    }

    if (type === 'event_msg') {
      switch (kind) {
        case 'task_started': {
          if (isMain) {
            // A turn can start without a prompt — a subagent's reply wakes the
            // root — so the start itself says the agent is working.
            events.push({
              ...base,
              kind: 'waiting.changed',
              payload: { status: { state: 'thinking' } },
            });
          } else {
            state.runs += 1;
            const followUp = state.runs > 1 && state.turnId !== undefined;
            events.push({
              ...base,
              kind: 'agent.started',
              dedupeKey: followUp
                ? dedupeKeys.agentFollowUp(state.agentId, state.turnId ?? '')
                : dedupeKeys.agentStarted(state.agentId),
              payload: {
                agentType: state.agentType ?? 'default',
                ...(state.task ? { description: state.task } : {}),
                ...(state.model ? { model: state.model } : {}),
                // Codex's spawn_agent returns at once; the parent waits, if it
                // waits, with a separate call.
                spawnMode: 'async',
                ...(followUp ? { followUp: true } : {}),
              },
            });
          }
          break;
        }

        case 'task_complete':
        case 'turn_aborted': {
          const interrupted = kind === 'turn_aborted';
          state.openCalls = {};
          delete state.waitingOn;
          if (isMain) {
            events.push({
              ...base,
              kind: 'waiting.changed',
              payload: { status: { state: 'idle' } },
            });
          } else if (state.runs > 0) {
            const result = preview(payload.last_agent_message);
            events.push({
              ...base,
              kind: 'agent.finished',
              dedupeKey: dedupeKeys.agentFollowUpFinished(state.agentId, state.turnId ?? ts),
              payload: {
                outcome: interrupted ? 'interrupted' : 'ok',
                ...(typeof payload.duration_ms === 'number'
                  ? { durationMs: Math.max(0, Math.round(payload.duration_ms)) }
                  : {}),
                ...(result ? { resultPreview: result } : {}),
                ...(state.parentAgentId ? { handedBackTo: state.parentAgentId } : {}),
              },
            });
          }
          break;
        }

        // Two layouts report the same message: `event_msg` records in Codex's
        // legacy history mode, `item_completed` items in its paginated one.
        // Both are read, and a key built from the turn and the text collapses
        // the pair if a version ever writes both. See docs/EVENT_MAP.md §9.
        case 'user_message':
          pushPrompt(events, base, state, str(payload.message) ?? '');
          break;
        case 'agent_message':
          pushSaid(events, base, state, str(payload.message) ?? '');
          break;
        case 'item_completed': {
          const item = isObj(payload.item) ? payload.item : {};
          if (item.type === 'UserMessage') pushPrompt(events, base, state, messageText(item));
          else if (item.type === 'AgentMessage') pushSaid(events, base, state, messageText(item));
          break;
        }

        case 'token_count': {
          // The account's limits ride on every usage report. Reported when
          // they change, or once a minute while unchanged: an unchanged figure
          // is still a fresh reading, not evidence that no response arrived.
          const plan = codexPlanUsage(payload.rate_limits);
          const planType = isObj(payload.rate_limits)
            ? str(payload.rate_limits.plan_type)
            : undefined;
          const reading = plan ? JSON.stringify([plan, planType]) : undefined;
          const readAtMs = Date.parse(ts);
          const heartbeat =
            Number.isFinite(readAtMs) &&
            (state.planReadingEmittedAtMs === undefined ||
              readAtMs - state.planReadingEmittedAtMs >= PLAN_READING_HEARTBEAT_MS);
          if (plan && (reading !== state.planReading || heartbeat)) {
            state.planReading = reading;
            if (Number.isFinite(readAtMs)) {
              state.planReadingEmittedAtMs = Math.max(
                state.planReadingEmittedAtMs ?? readAtMs,
                readAtMs,
              );
            }
            events.push({
              ...base,
              kind: 'plan.usage.updated',
              payload: { usage: plan, harness: 'codex', ...(planType ? { planType } : {}) },
            });
          }
          const info = isObj(payload.info) ? payload.info : undefined;
          const last = info && isObj(info.last_token_usage) ? info.last_token_usage : undefined;
          const window =
            typeof info?.model_context_window === 'number' ? info.model_context_window : 0;
          const input = typeof last?.input_tokens === 'number' ? last.input_tokens : undefined;
          const output = typeof last?.output_tokens === 'number' ? last.output_tokens : 0;
          const percent =
            input !== undefined && window > 0
              ? Math.min(100, Math.round((input / window) * 100))
              : undefined;
          if (
            isMain &&
            percent !== undefined &&
            input !== undefined &&
            percent !== state.contextPercent
          ) {
            state.contextPercent = percent;
            events.push({
              ...base,
              kind: 'usage.updated',
              payload: {
                scope: 'session',
                tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
                context: {
                  usedPercentage: percent,
                  contextWindowSize: Math.round(window),
                  totalInputTokens: Math.round(input),
                  totalOutputTokens: Math.round(output),
                },
              },
            });
          }
          break;
        }

        case 'context_compacted':
          events.push({ ...base, kind: 'context.compacted', payload: { phase: 'pre' } });
          break;
      }
      continue;
    }

    if (type === 'token_usage_record') {
      // A forked thread's record of its parent's usage names the parent.
      if (str(payload.thread_id) && payload.thread_id !== state.threadId) continue;
      const usage = isObj(payload.usage) ? payload.usage : undefined;
      if (!usage) continue;
      const n = (key: string) =>
        typeof usage[key] === 'number' ? Math.max(0, Math.round(usage[key] as number)) : 0;
      const cached = n('cached_input_tokens');
      const responseId = str(payload.response_id);
      events.push({
        ...base,
        kind: 'usage.updated',
        ...(responseId ? { dedupeKey: dedupeKeys.usageForMessage(responseId) } : {}),
        payload: {
          scope: 'agent',
          // OpenAI counts cached input inside input; the board keeps them apart.
          tokens: {
            input: Math.max(0, n('input_tokens') - cached),
            output: n('output_tokens'),
            cacheCreation: n('cache_write_input_tokens'),
            cacheRead: cached,
            thinking: n('reasoning_output_tokens'),
          },
          ...(state.model ? { model: state.model } : {}),
        },
      });
      continue;
    }

    if (type !== 'response_item') continue;
    const callId = str(payload.call_id);

    if ((kind === 'custom_tool_call' || kind === 'function_call') && callId) {
      const name = str(payload.name) ?? 'tool';
      const namespace = str(payload.namespace);
      const text =
        kind === 'custom_tool_call' ? (str(payload.input) ?? '') : (str(payload.arguments) ?? '');

      if (namespace === 'collaboration') {
        pushCollaboration(events, base, state, name, callId, text);
        continue;
      }
      if (name === 'request_user_input') {
        pushQuestion(events, base, state, callId, text);
        continue;
      }
      // Bookkeeping calls with nothing to show: an asynchronous question is
      // echoed as the agent's own message, a sleep is a pause.
      if (name === 'request_user_input_async' || name === 'sleep' || name === 'wait') continue;

      for (const skill of skillsIn(text)) {
        if (state.skillsThisTurn.includes(skill)) continue;
        state.skillsThisTurn.push(skill);
        events.push({ ...base, kind: 'skill.invoked', payload: { skillName: skill } });
      }

      const tool = name === 'exec' ? scriptTool(text) : (TOOL_NAMES[name] ?? name);
      if (tool === 'TodoWrite') continue;
      state.openCalls[callId] = tool;
      events.push({
        ...base,
        kind: 'tool.started',
        correlationId: callId,
        dedupeKey: dedupeKeys.toolStarted(callId),
        payload: { toolUseId: callId, toolName: tool, summary: summaryOf(tool, text) },
      });
      continue;
    }

    if ((kind === 'custom_tool_call_output' || kind === 'function_call_output') && callId) {
      if (state.waitingOn === callId) {
        delete state.waitingOn;
        events.push({
          ...base,
          kind: 'waiting.changed',
          payload: { status: { state: 'thinking' } },
        });
        continue;
      }
      const tool = state.openCalls[callId];
      if (!tool) continue;
      delete state.openCalls[callId];
      const error = failed(outputText(payload.output));
      events.push(
        error
          ? {
              ...base,
              kind: 'tool.failed',
              correlationId: callId,
              dedupeKey: dedupeKeys.toolFailed(callId),
              payload: { toolUseId: callId, toolName: tool, errorPreview: preview(error) },
            }
          : {
              ...base,
              kind: 'tool.finished',
              correlationId: callId,
              dedupeKey: dedupeKeys.toolFinished(callId),
              payload: { toolUseId: callId, toolName: tool },
            },
      );
    }
  }

  return { events, warnings };
};

type Base = Omit<
  Extract<DraftEvent, { kind: 'waiting.changed' }>,
  'kind' | 'payload' | 'dedupeKey'
>;

const pushPrompt = (events: DraftEvent[], base: Base, state: CodexThreadState, text: string) => {
  // A subagent's instruction arrives from its parent, encrypted, and is not a
  // person typing. Only the root has prompts.
  if (state.agentId !== MAIN_AGENT_ID) return;
  const body = text.trim();
  if (!body) return;
  events.push({
    ...base,
    kind: 'prompt.submitted',
    ...(state.turnId ? { correlationId: state.turnId } : {}),
    dedupeKey: dedupeKeys.promptSubmitted(`${state.turnId ?? base.ts}:${hash(body)}`),
    payload: {
      ...(state.promptId ? { promptId: state.promptId } : {}),
      preview: preview(body),
      charCount: body.length,
    },
  });
};

const pushSaid = (events: DraftEvent[], base: Base, state: CodexThreadState, text: string) => {
  const said = preview(text, SAID_PREVIEW_LENGTH);
  if (!said) return;
  events.push({
    ...base,
    kind: 'agent.said',
    dedupeKey: dedupeKeys.saidInMessage(
      `${state.threadId}:${state.turnId ?? ''}:${hash(text.trim())}`,
      0,
    ),
    payload: {
      text: said,
      ...(text.trim().length > SAID_PREVIEW_LENGTH ? { truncated: true } : {}),
    },
  });
};

/**
 * Codex's team tools. Spawning is recorded in the child's own file, where the
 * edge is data, so here it only teaches the parent what it is waiting on.
 * Messages between agents are encrypted and never shown.
 */
const pushCollaboration = (
  events: DraftEvent[],
  base: Base,
  state: CodexThreadState,
  name: string,
  callId: string,
  argumentsText: string,
) => {
  let args: Json = {};
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (isObj(parsed)) args = parsed;
  } catch {
    // Unreadable arguments cost the detail, not the event.
  }
  if (name === 'spawn_agent') {
    const role = str(args.agent_type);
    if (role && !state.spawnedRoles.includes(role)) state.spawnedRoles.push(role);
    return;
  }
  if (name !== 'wait_agent') return;
  // Every wait names what it waits on: a board that says only "waiting" is a
  // bug (CLAUDE.md). Codex does not say which agents; the ones this thread
  // spawned are the honest answer. A thread that spawned none is waiting on
  // the rest of its team — its coordinator, usually — and says so instead.
  const subject = state.spawnedRoles.length > 0 ? state.spawnedRoles.join(', ') : undefined;
  state.waitingOn = callId;
  events.push({
    ...base,
    kind: 'waiting.changed',
    payload: {
      status: {
        state: 'waiting_subagent',
        waitingOn: {
          summary: subject ? `Waiting on ${subject}` : 'Waiting on other agents',
          reason: 'subagent',
          ...(subject ? { subject } : {}),
          since: base.ts,
          ref: callId,
        },
      },
    },
  });
};

const pushQuestion = (
  events: DraftEvent[],
  base: Base,
  state: CodexThreadState,
  callId: string,
  argumentsText: string,
) => {
  let title = '';
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    const questions = isObj(parsed) && Array.isArray(parsed.questions) ? parsed.questions : [];
    const first: unknown = questions[0];
    title = isObj(first) ? (str(first.title) ?? str(first.question) ?? '') : '';
  } catch {
    // The state still says the agent is waiting on the person, without the question.
  }
  state.waitingOn = callId;
  const question = preview(title);
  events.push({
    ...base,
    kind: 'waiting.changed',
    payload: {
      status: {
        state: 'waiting_input',
        waitingOn: {
          summary: question || 'Waiting for your reply',
          reason: 'input',
          ...(question ? { detail: question } : {}),
          since: base.ts,
          ref: callId,
        },
      },
    },
  });
};
