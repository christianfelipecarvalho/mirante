import type { DraftEvent, Entrypoint } from '@mirante/shared';
import { MAIN_AGENT_ID, dedupeKeys } from '@mirante/shared';
import { preview, summarizeToolInput } from '../../core/redact.js';
import {
  agentToolResultSchema,
  subagentMetaSchema,
  transcriptEntrySchema,
  type SubagentMeta,
  type TranscriptEntry,
} from './schema.js';

/** One `agent-<agentId>.jsonl` plus its sibling `.meta.json`, already read from disk. */
export type SubagentTranscript = {
  agentId: string;
  meta?: unknown;
  lines: readonly unknown[];
};

/**
 * A whole session as files, already read. The parser performs no I/O: it takes
 * content and returns events, which is what lets it be tested offline against
 * recorded fixtures rather than against a live session.
 */
export type SessionTranscript = {
  mainLines: readonly unknown[];
  subagents?: readonly SubagentTranscript[];
};

export type ParseResult = {
  events: DraftEvent[];
  /** Entries that did not match even the lenient schema. A rising count means drift. */
  skipped: number;
  /** Things `mirante doctor` should tell the user about. */
  warnings: string[];
};

const ENTRYPOINT_MAP: readonly [RegExp, Entrypoint][] = [
  [/vscode|vs-code|cursor/i, 'vscode'],
  [/sdk/i, 'sdk'],
  [/print|headless|^-p$/i, 'print'],
  [/cli|repl|terminal/i, 'cli'],
];

export const normalizeEntrypoint = (raw: string | undefined): Entrypoint => {
  if (!raw) return 'unknown';
  for (const [pattern, value] of ENTRYPOINT_MAP) if (pattern.test(raw)) return value;
  return 'unknown';
};

const parseLines = (lines: readonly unknown[]): { entries: TranscriptEntry[]; skipped: number } => {
  const entries: TranscriptEntry[] = [];
  let skipped = 0;
  for (const line of lines) {
    const parsed = transcriptEntrySchema.safeParse(line);
    if (parsed.success) entries.push(parsed.data);
    else skipped += 1;
  }
  return { entries, skipped };
};

const contentBlocks = (entry: TranscriptEntry): Record<string, unknown>[] => {
  const content = entry.message?.content;
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
};

const toolUseBlocks = (entry: TranscriptEntry) =>
  contentBlocks(entry).filter(
    (b): b is { type: 'tool_use'; id: string; name: string; input?: unknown } =>
      b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string',
  );

const normalizeUsage = (usage: NonNullable<TranscriptEntry['message']>['usage']) => ({
  input: usage?.input_tokens ?? 0,
  output: usage?.output_tokens ?? 0,
  cacheCreation: usage?.cache_creation_input_tokens ?? 0,
  cacheRead: usage?.cache_read_input_tokens ?? 0,
  ...(usage?.output_tokens_details?.thinking_tokens === undefined
    ? {}
    : { thinking: usage.output_tokens_details.thinking_tokens }),
});

/**
 * Markers Claude Code uses for messages it writes to itself — a subagent handing
 * work back, a task notification, a reminder injected into the turn.
 *
 * These arrive as ordinary `type: "user"` entries with string content, so
 * nothing but the content distinguishes them from something a person typed.
 * Counting them as requests fills the board with machine chatter and makes the
 * request list useless.
 */
const INJECTED_PREFIXES = [
  '<task-notification>',
  '<agent-message',
  '<system-reminder>',
  '<local-command-',
  '<command-name>',
  '[Subagent hand-back]',
  '<user-prompt-submit-hook>',
];

const isInjectedMessage = (text: string): boolean => {
  const head = text.trimStart();
  return INJECTED_PREFIXES.some((prefix) => head.startsWith(prefix));
};

/**
 * A user entry is a real human prompt only when it is not a tool result, not an
 * injected meta message, and not something Claude Code wrote to itself. All of
 * those are also `type: "user"`, so the type alone tells you nothing.
 */
const isHumanPrompt = (entry: TranscriptEntry): boolean => {
  if (entry.type !== 'user' || entry.isMeta === true || entry.toolUseResult !== undefined) {
    return false;
  }
  if (contentBlocks(entry).some((b) => b.type === 'tool_result')) return false;
  return !isInjectedMessage(promptText(entry));
};

const promptText = (entry: TranscriptEntry): string => {
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  return contentBlocks(entry)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
};

const isFailedResult = (entry: TranscriptEntry): boolean => {
  const result = entry.toolUseResult;
  if (typeof result === 'object' && result !== null) {
    const r = result as Record<string, unknown>;
    if (r.interrupted === true) return true;
    if (r.success === false) return true;
  }
  return contentBlocks(entry).some((b) => b.type === 'tool_result' && b.is_error === true);
};

/** What an `Agent` tool-use block declared, indexed by its tool-use id. */
type SpawnInfo = { subagentType?: string; description?: string; model?: string };

type EmitContext = {
  agentId: string;
  parentAgentId?: string;
  agentType?: string;
  toolNameById: Map<string, string>;
  spawnInfoByToolUseId: Map<string, SpawnInfo>;
  agentTypeByAgentId: Map<string, string>;
  warnings: string[];
};

const emitForEntries = (entries: readonly TranscriptEntry[], ctx: EmitContext): DraftEvent[] => {
  const events: DraftEvent[] = [];
  const isMain = ctx.agentId === MAIN_AGENT_ID;
  let lastSkill: string | undefined;
  /**
   * Only `user` entries carry `promptId`; the assistant turns that answer them do
   * not. Tools and token usage all hang off assistant entries, so reading the
   * field literally attributes nothing to the request that caused it — every
   * request would report zero tools and zero tokens. The id carries forward
   * until the next prompt replaces it.
   */
  let currentPromptId: string | undefined;

  const base = (entry: TranscriptEntry) => ({
    ts: entry.timestamp ?? new Date(0).toISOString(),
    source: 'transcript' as const,
    sessionId: entry.sessionId ?? '',
    projectPath: entry.cwd ?? '',
    ...(entry.gitBranch === undefined ? {} : { gitBranch: entry.gitBranch }),
    agentId: ctx.agentId,
    ...(ctx.agentType === undefined ? {} : { agentType: ctx.agentType }),
    ...(ctx.parentAgentId === undefined ? {} : { parentAgentId: ctx.parentAgentId }),
    // Every event carries the turn that caused it, so a request can be costed.
    ...(currentPromptId === undefined ? {} : { promptId: currentPromptId }),
  });

  // Transcripts open with bookkeeping records — bridge-session, queue-operation,
  // ai-title and friends — that carry no cwd and often no timestamp. Treating the
  // first line as the start of the session reads project, branch and entrypoint
  // off a record that has none of them.
  const conversational = entries.filter(
    (entry) => entry.type === 'user' || entry.type === 'assistant',
  );
  let sessionStartEmitted = false;

  conversational.forEach((entry) => {
    if (entry.promptId) currentPromptId = entry.promptId;

    if (isMain && !sessionStartEmitted && entry.cwd && entry.timestamp) {
      sessionStartEmitted = true;
      events.push({
        ...base(entry),
        kind: 'session.started',
        dedupeKey: dedupeKeys.sessionStarted(entry.sessionId ?? ''),
        payload: {
          entrypoint: normalizeEntrypoint(entry.entrypoint),
          cwd: entry.cwd ?? '',
          ...(entry.version === undefined ? {} : { claudeVersion: entry.version }),
          ...(entry.message?.model === undefined ? {} : { model: entry.message.model }),
        },
      });
    }

    // `attributionSkill` is the validated source for the active skill: it is set
    // on every entry the skill covers, so a skill invoked before the window still
    // shows up. See docs/EVENT_MAP.md §6 D4.
    // `attributionSkill` is absent on entries the skill does not cover, so it
    // flickers between a name and nothing while a skill is active. Tracking the
    // last *named* skill instead of the last value collapses that into one
    // timeline row per invocation rather than one per toggle.
    const skill = entry.attributionSkill ?? undefined;
    if (skill && skill !== lastSkill) {
      events.push({
        ...base(entry),
        kind: 'skill.invoked',
        payload: { skillName: skill },
      });
      lastSkill = skill;
    }

    if (entry.type === 'assistant') {
      if (entry.message?.usage) {
        events.push({
          ...base(entry),
          kind: 'usage.updated',
          ...(entry.uuid === undefined
            ? {}
            : { dedupeKey: dedupeKeys.usageForMessage(entry.uuid) }),
          payload: {
            scope: 'agent',
            tokens: normalizeUsage(entry.message.usage),
            ...(entry.message.model === undefined ? {} : { model: entry.message.model }),
          },
        });
      }

      for (const block of toolUseBlocks(entry)) {
        ctx.toolNameById.set(block.id, block.name);
        // An `Agent` call is a handoff, not a tool row. It becomes `agent.started`
        // once the result carries the agent id.
        if (block.name === 'Agent') continue;
        events.push({
          ...base(entry),
          kind: 'tool.started',
          correlationId: block.id,
          dedupeKey: dedupeKeys.toolStarted(block.id),
          payload: {
            toolUseId: block.id,
            toolName: block.name,
            summary: summarizeToolInput(block.name, block.input),
          },
        });
      }
      return;
    }

    if (entry.type !== 'user') return;

    if (isHumanPrompt(entry)) {
      const text = promptText(entry);
      events.push({
        ...base(entry),
        kind: 'prompt.submitted',
        ...(entry.promptId === undefined ? {} : { correlationId: entry.promptId }),
        ...(entry.promptId === undefined
          ? {}
          : { dedupeKey: dedupeKeys.promptSubmitted(entry.promptId) }),
        payload: { preview: preview(text), charCount: text.length },
      });
      return;
    }

    if (entry.toolUseResult === undefined) return;

    const resultBlock = contentBlocks(entry).find((b) => b.type === 'tool_result');
    const toolUseId =
      typeof resultBlock?.tool_use_id === 'string' ? resultBlock.tool_use_id : undefined;

    const agentResult = agentToolResultSchema.safeParse(entry.toolUseResult);
    if (agentResult.success) {
      // The launch record. `agent.started` is emitted here rather than at the
      // tool-use block because only the result carries the agent id.
      const r = agentResult.data;
      const spawn = toolUseId ? ctx.spawnInfoByToolUseId.get(toolUseId) : undefined;
      // The subagent's own meta.json is authoritative; the spawning tool-use input
      // covers agents whose transcript was not read, or was not written yet.
      const agentType = ctx.agentTypeByAgentId.get(r.agentId) ?? spawn?.subagentType ?? 'unknown';
      const description = r.description ?? spawn?.description;
      events.push({
        ...base(entry),
        agentId: r.agentId,
        agentType,
        parentAgentId: ctx.agentId,
        ...(toolUseId === undefined ? {} : { correlationId: toolUseId }),
        kind: 'agent.started',
        dedupeKey: dedupeKeys.agentStarted(r.agentId),
        payload: {
          agentType,
          ...(description === undefined ? {} : { description: preview(description) }),
          ...((r.resolvedModel ?? spawn?.model) ? { model: r.resolvedModel ?? spawn?.model } : {}),
          spawnMode: r.isAsync === true || r.status === 'async_launched' ? 'async' : 'sync',
          ...(toolUseId === undefined ? {} : { toolUseId }),
        },
      });
      return;
    }

    if (!toolUseId) return;

    const toolName = ctx.toolNameById.get(toolUseId) ?? 'unknown';
    if (isFailedResult(entry)) {
      events.push({
        ...base(entry),
        correlationId: toolUseId,
        dedupeKey: dedupeKeys.toolFailed(toolUseId),
        kind: 'tool.failed',
        payload: { toolUseId, toolName, errorPreview: preview(resultBlock?.content) },
      });
    } else {
      events.push({
        ...base(entry),
        correlationId: toolUseId,
        dedupeKey: dedupeKeys.toolFinished(toolUseId),
        kind: 'tool.finished',
        payload: { toolUseId, toolName },
      });
    }
  });

  return events;
};

/**
 * Turns a session's files into normalized events.
 *
 * The whole board is reconstructible from this alone — hooks only make it
 * faster. That is the point of ADR-0004, and it is why this function is pure.
 */
export const parseSessionTranscript = (input: SessionTranscript): ParseResult => {
  const warnings: string[] = [];
  const toolNameById = new Map<string, string>();

  const main = parseLines(input.mainLines);
  let skipped = main.skipped;

  const subagents = (input.subagents ?? []).map((sub) => {
    const parsed = parseLines(sub.lines);
    skipped += parsed.skipped;
    const meta = subagentMetaSchema.safeParse(sub.meta ?? {});
    if (!meta.success) warnings.push(`agent ${sub.agentId}: unreadable meta.json`);
    return {
      ...sub,
      entries: parsed.entries,
      meta: meta.success ? meta.data : ({} as SubagentMeta),
    };
  });

  // Index every tool use before emitting, so a result can name its tool even when
  // the call was made in a different file or earlier than the window read.
  const spawnInfoByToolUseId = new Map<string, SpawnInfo>();
  const indexEntry = (entry: TranscriptEntry) => {
    for (const block of toolUseBlocks(entry)) {
      toolNameById.set(block.id, block.name);
      if (block.name !== 'Agent') continue;
      const input = (
        typeof block.input === 'object' && block.input !== null ? block.input : {}
      ) as Record<string, unknown>;
      spawnInfoByToolUseId.set(block.id, {
        ...(typeof input.subagent_type === 'string' ? { subagentType: input.subagent_type } : {}),
        ...(typeof input.description === 'string' ? { description: input.description } : {}),
        ...(typeof input.model === 'string' ? { model: input.model } : {}),
      });
    }
  };
  for (const entry of main.entries) indexEntry(entry);
  for (const sub of subagents) for (const entry of sub.entries) indexEntry(entry);

  const agentTypeByAgentId = new Map<string, string>();
  for (const sub of subagents) {
    const agentType = (sub.meta as SubagentMeta).agentType;
    if (agentType) agentTypeByAgentId.set(sub.agentId, agentType);
  }

  /** Which transcript issued a given tool use — this resolves parents beyond depth 1. */
  const ownerByToolUseId = new Map<string, string>();
  for (const entry of main.entries)
    for (const b of toolUseBlocks(entry)) ownerByToolUseId.set(b.id, MAIN_AGENT_ID);
  for (const sub of subagents)
    for (const entry of sub.entries)
      for (const b of toolUseBlocks(entry)) ownerByToolUseId.set(b.id, sub.agentId);

  const shared = { toolNameById, spawnInfoByToolUseId, agentTypeByAgentId, warnings };
  const events = emitForEntries(main.entries, { agentId: MAIN_AGENT_ID, ...shared });

  for (const sub of subagents) {
    const meta = sub.meta as SubagentMeta;
    const parentAgentId = meta.toolUseId ? ownerByToolUseId.get(meta.toolUseId) : undefined;
    if (meta.toolUseId && !parentAgentId) {
      warnings.push(
        `agent ${sub.agentId}: spawning tool use ${meta.toolUseId} not found in session`,
      );
    }

    events.push(
      ...emitForEntries(sub.entries, {
        agentId: sub.agentId,
        parentAgentId: parentAgentId ?? MAIN_AGENT_ID,
        ...(meta.agentType === undefined ? {} : { agentType: meta.agentType }),
        ...shared,
      }),
    );

    // Heuristic, and marked as one: a file whose last entry is an assistant
    // `end_turn` is a finished agent. The SubagentStop hook is authoritative when
    // the daemon was running; this is what makes replay-from-disk work when it
    // was not.
    const last = sub.entries.at(-1);
    if (last?.type === 'assistant' && last.message?.stop_reason === 'end_turn') {
      events.push({
        ts: last.timestamp ?? new Date(0).toISOString(),
        source: 'transcript',
        sessionId: last.sessionId ?? '',
        projectPath: last.cwd ?? '',
        agentId: sub.agentId,
        ...(meta.agentType === undefined ? {} : { agentType: meta.agentType }),
        parentAgentId: parentAgentId ?? MAIN_AGENT_ID,
        kind: 'agent.finished',
        dedupeKey: dedupeKeys.agentFinished(sub.agentId),
        payload: { outcome: 'ok', handedBackTo: parentAgentId ?? MAIN_AGENT_ID },
      });
    }
  }

  // Stable chronological order: events from different files interleave, and the
  // timeline is read top to bottom.
  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.ts.localeCompare(b.event.ts) || a.index - b.index)
    .map(({ event }) => event);

  return { events: ordered, skipped, warnings };
};
