import { resolve } from 'node:path';
import type { DraftEvent, Entrypoint } from '@mirante/shared';
import {
  MAIN_AGENT_ID,
  emptyTokenUsage,
  dedupeKeys,
  isInjectedMessage,
  stripEditorContext,
  reportedEffort,
  isTaskContinuation,
} from '@mirante/shared';
import {
  SAID_PREVIEW_LENGTH,
  captureInstruction,
  preview,
  summarizeToolInput,
} from '../../core/redact.js';
import { ConfirmedClaudePlans, failedWorkPlanResult } from '../../core/work-plan.js';
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
 * A user entry is a real human prompt only when it is not a tool result, not an
 * injected meta message, and not something Claude Code wrote to itself. All of
 * those are also `type: "user"`, so the type alone tells you nothing.
 */
const isHumanPrompt = (entry: TranscriptEntry): boolean => {
  if (entry.type !== 'user' || entry.isMeta === true || entry.toolUseResult !== undefined) {
    return false;
  }
  if (contentBlocks(entry).some((b) => b.type === 'tool_result')) return false;
  // The first entry of a subagent's transcript is the brief its parent wrote,
  // not something a person typed. It also carries the *parent turn's*
  // `promptId`, so recording it as a prompt made it collide with the real
  // request and with every sibling brief of the same turn — seven of eight
  // briefs were dropped by that collision. It travels with `agent.started`
  // instead. See docs/EVENT_MAP.md D13.
  if (entry.isSidechain === true && !entry.parentUuid) return false;
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

const TASK_NOTIFICATION =
  /<task-notification>[\s\S]*?<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/;

const OUTCOME_BY_STATUS: Record<string, 'ok' | 'error' | 'interrupted'> = {
  completed: 'ok',
  failed: 'error',
  killed: 'interrupted',
  stopped: 'interrupted',
  cancelled: 'interrupted',
};

/**
 * A subagent's end, as Claude Code reports it to the parent.
 *
 * It arrives as a queued command in an `attachment` entry, and sometimes also as
 * a plain user entry. Everything else about the entry is bookkeeping, which is
 * why the conversational pass never sees it.
 */
const taskNotificationOf = (
  entry: TranscriptEntry,
): { taskId: string; outcome: 'ok' | 'error' | 'interrupted'; resultText?: string } | undefined => {
  const attachment = (entry as { attachment?: unknown }).attachment;
  const text =
    entry.type === 'attachment' && typeof attachment === 'object' && attachment !== null
      ? (attachment as { prompt?: unknown }).prompt
      : entry.type === 'user'
        ? promptText(entry)
        : undefined;
  if (typeof text !== 'string') return undefined;
  const match = TASK_NOTIFICATION.exec(text);
  const outcome = match?.[2] ? OUTCOME_BY_STATUS[match[2].trim()] : undefined;
  const resultText = /<result>([\s\S]*?)<\/result>/.exec(text)?.[1];
  return match?.[1] && outcome
    ? { taskId: match[1].trim(), outcome, ...(resultText ? { resultText } : {}) }
    : undefined;
};

const finalAssistantResult = (entry: TranscriptEntry | undefined): string | undefined =>
  entry?.type === 'assistant' &&
  entry.message?.stop_reason === 'end_turn' &&
  toolUseBlocks(entry).length === 0
    ? promptText(entry)
    : undefined;

const nativeAgentResult = (result: Record<string, unknown>): string | undefined => {
  if (result.status !== 'completed' || !Array.isArray(result.content)) return undefined;
  const text = result.content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        block.type === 'text' &&
        typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('\n');
  return text;
};

const resultDetails = (value: unknown) => {
  const captured = captureInstruction(value);
  return {
    resultAvailability: captured.availability,
    ...(captured.text ? { resultPreview: captured.text } : {}),
    ...(captured.charCount === undefined ? {} : { resultCharCount: captured.charCount }),
    ...(captured.truncated === undefined ? {} : { resultTruncated: captured.truncated }),
  };
};

/** Claude Code's window names, mapped onto the keys the rest of Mirante uses. */
const windowKey = (raw: string): string =>
  raw === 'five_hour' ? 'fiveHour' : raw === 'seven_day' ? 'sevenDay' : raw;

const isFailedResult = (entry: TranscriptEntry): boolean => {
  const result = entry.toolUseResult;
  if (typeof result === 'object' && result !== null) {
    const r = result as Record<string, unknown>;
    if (r.interrupted === true) return true;
    if (r.success === false) return true;
  }
  return contentBlocks(entry).some((b) => b.type === 'tool_result' && b.is_error === true);
};

/** Prefer the fullest recorded copy, ignoring empty copies from partial flushes. */
const longestBrief = (...values: (string | undefined)[]): string | undefined =>
  values
    .filter((value): value is string => Boolean(value?.trim()))
    .sort(
      (a, b) =>
        Number(captureInstruction(b).availability === 'captured') -
          Number(captureInstruction(a).availability === 'captured') ||
        b.trim().length - a.trim().length,
    )[0];

/** What an `Agent` tool-use block declared, indexed by its tool-use id. */
type SpawnInfo = {
  subagentType?: string;
  description?: string;
  model?: string;
  /** The instruction the parent wrote. The `Agent` result repeats it. */
  prompt?: string;
  resume?: string;
  name?: string;
  background?: boolean;
};

type EmitContext = {
  agentId: string;
  parentAgentId?: string;
  agentType?: string;
  toolNameById: Map<string, string>;
  spawnInfoByToolUseId: Map<string, SpawnInfo>;
  agentTypeByAgentId: Map<string, string>;
  warnings: string[];
  agentIdByRecipient: Map<string, string>;
  instructionCopies: Set<string>;
  sourceOwnerByUuid: Map<string, string>;
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
  const responses = new Map<string, { latest: TranscriptEntry; legacyKeys: Set<string> }>();
  for (const entry of conversational) {
    if (
      entry.type !== 'assistant' ||
      entry.isApiErrorMessage ||
      !entry.message?.usage ||
      !entry.message.id
    )
      continue;
    const response = responses.get(entry.message.id) ?? {
      latest: entry,
      legacyKeys: new Set<string>(),
    };
    response.latest = entry;
    if (entry.uuid) response.legacyKeys.add(dedupeKeys.usageForMessage(entry.uuid));
    responses.set(entry.message.id, response);
  }

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
          // `<synthetic>` marks a message Claude Code wrote itself — a refusal at
          // the plan limit, say. It is not a model, and a session opened by one
          // would otherwise name it as its model.
          ...(entry.message?.model === undefined || entry.message.model === '<synthetic>'
            ? {}
            : { model: entry.message.model }),
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
    // A new request starts with no skill in use. Without forgetting the last one
    // here, a skill used again in the next turn would never be reported, and the
    // card — which clears its skill on each prompt — would show none.
    if (entry.type === 'user' && isHumanPrompt(entry)) lastSkill = undefined;
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
      const effort = reportedEffort(entry.effort);
      const model = entry.message?.model;
      const reportedModel = model && model !== '<synthetic>' ? model : undefined;
      if (effort !== undefined || reportedModel) {
        events.push({
          ...base(entry),
          kind: 'agent.metadata.updated',
          dedupeKey: `agent.metadata.updated:${entry.sessionId}:${ctx.agentId}:${entry.uuid ?? entry.timestamp}`,
          payload: { ...(reportedModel ? { model: reportedModel } : {}), effort: effort ?? null },
        });
      }
      // A refusal from the API, written by Claude Code itself: the model never
      // ran, the usage is all zeros, and the only content is the reason.
      if (entry.isApiErrorMessage === true) {
        const limited = entry.error === 'rate_limit';
        const window = entry.quotaLimits?.rateLimitType;
        const resetsAt = entry.quotaLimits?.resetsAt;
        events.push({
          ...base(entry),
          kind: 'error.raised',
          ...(entry.uuid === undefined
            ? {}
            : { dedupeKey: dedupeKeys.errorForMessage(entry.uuid) }),
          payload: {
            kind: limited ? 'rate_limit' : 'api',
            message: preview(promptText(entry) || entry.error || 'API error'),
            ...(limited && (window !== undefined || resetsAt !== undefined)
              ? {
                  limit: {
                    ...(window === undefined ? {} : { window: windowKey(window) }),
                    ...(resetsAt === undefined ? {} : { resetsAt: Math.floor(resetsAt) }),
                  },
                }
              : {}),
          },
        });
        return;
      }

      const response = entry.message?.id ? responses.get(entry.message.id) : undefined;
      if (entry.message?.usage && (!response || response.latest === entry)) {
        events.push({
          ...base(entry),
          kind: 'usage.updated',
          ...(response && entry.message.id
            ? { dedupeKey: `usage.response:${entry.sessionId}:${ctx.agentId}:${entry.message.id}` }
            : entry.uuid === undefined
              ? {}
              : { dedupeKey: dedupeKeys.usageForMessage(entry.uuid) }),
          payload: {
            scope: 'agent',
            ...(response && entry.message.id
              ? { responseId: entry.message.id, replacesUsageKeys: [...response.legacyKeys] }
              : {}),
            tokens: normalizeUsage(entry.message.usage),
            ...(entry.message.model === undefined ? {} : { model: entry.message.model }),
          },
        });
      }

      /*
       * What the agent wrote, in the order a person would have read it: the
       * prose comes before the tool call it announces.
       *
       * The thinking Claude Code streams to the terminal is not here to be
       * read — it reaches the transcript with an empty `thinking` field and a
       * signature only. See docs/EVENT_MAP.md D12.
       */
      contentBlocks(entry).forEach((block, index) => {
        if (block.type !== 'text' || typeof block.text !== 'string') return;
        const said = preview(block.text, SAID_PREVIEW_LENGTH);
        if (!said) return;
        events.push({
          ...base(entry),
          kind: 'agent.said',
          ...(entry.uuid === undefined
            ? {}
            : { dedupeKey: dedupeKeys.saidInMessage(entry.uuid, index) }),
          payload: {
            text: said,
            ...(block.text.trim().length > SAID_PREVIEW_LENGTH ? { truncated: true } : {}),
          },
        });
      });

      for (const block of toolUseBlocks(entry)) {
        ctx.toolNameById.set(block.id, block.name);
        // An `Agent` call is a handoff, not a tool row. It becomes `agent.started`
        // once the result carries the agent id.
        if (block.name === 'Agent' || block.name === 'Task') continue;
        if (
          block.name === 'SendMessage' &&
          typeof block.input === 'object' &&
          block.input !== null
        ) {
          const input = block.input as Record<string, unknown>;
          if (
            input.type === 'message' ||
            input.type === 'broadcast' ||
            (input.type === undefined && typeof input.recipient === 'string')
          ) {
            const recipient =
              typeof input.recipient === 'string'
                ? ctx.agentIdByRecipient.get(input.recipient)
                : undefined;
            events.push({
              ...base(entry),
              agentId: recipient ?? ctx.agentId,
              kind: 'agent.instruction',
              // One SendMessage call is one delivery (or broadcast), even when a
              // later metadata flush resolves its previously unknown recipient.
              dedupeKey: dedupeKeys.agentInstruction(block.id),
              correlationId: block.id,
              payload: {
                senderAgentId: ctx.agentId,
                ...(recipient ? { recipientAgentId: recipient } : {}),
                instructionType: input.type === 'broadcast' ? 'broadcast' : 'message',
                ...captureInstruction(input.content ?? input.message),
              },
            });
          }
        }
        // A skill loaded through the `Skill` tool leaves no `attributionSkill`
        // on the entries that follow — observed on 2.1.27x — so the call itself
        // is the report. `lastSkill` keeps a later attribution of the same
        // skill from reporting it twice. See docs/EVENT_MAP.md D4.
        const skillName =
          block.name === 'Skill' && typeof block.input === 'object' && block.input !== null
            ? (block.input as Record<string, unknown>).skill
            : undefined;
        if (typeof skillName === 'string' && skillName.length > 0 && skillName !== lastSkill) {
          events.push({ ...base(entry), kind: 'skill.invoked', payload: { skillName } });
          lastSkill = skillName;
        }
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

    // An explicit source UUID links a delivered copy to a call already read.
    // Never merge separate messages merely because their text happens to match.
    if (
      entry.toolUseResult === undefined &&
      !contentBlocks(entry).some((block) => block.type === 'tool_result') &&
      entry.sourceToolAssistantUUID &&
      ctx.instructionCopies.has(`${ctx.agentId}|${entry.sourceToolAssistantUUID}`)
    )
      return;
    const teammate =
      /^\s*<teammate-message\b[^>]*\bteammate_id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/teammate-message>\s*$/.exec(
        promptText(entry),
      );
    if (teammate?.[1]) {
      events.push({
        ...base(entry),
        kind: 'agent.instruction',
        dedupeKey: dedupeKeys.agentInstruction(
          entry.uuid ?? `${ctx.agentId}:${entry.timestamp ?? ''}`,
          ctx.agentId,
        ),
        payload: {
          senderAgentId: ctx.agentIdByRecipient.get(teammate[1]) ?? teammate[1],
          recipientAgentId: ctx.agentId,
          instructionType: 'message',
          ...captureInstruction(teammate[2]),
        },
      });
      return;
    }

    if (isHumanPrompt(entry)) {
      // Editor context comes first in the entry; without stripping it the
      // preview holds only "The user opened the file …" and never the request.
      const text = stripEditorContext(promptText(entry));
      // The opening assignment is recovered on agent.started below, even if
      // an older transcript omitted isSidechain.
      if (!isMain && !entry.parentUuid) return;
      if (!isMain) {
        events.push({
          ...base(entry),
          kind: 'agent.instruction',
          dedupeKey: dedupeKeys.agentInstruction(
            entry.uuid ?? `${ctx.agentId}:${entry.timestamp ?? ''}`,
            ctx.agentId,
          ),
          payload: {
            senderAgentId:
              (entry.sourceToolAssistantUUID
                ? ctx.sourceOwnerByUuid.get(entry.sourceToolAssistantUUID)
                : undefined) ?? 'unknown',
            recipientAgentId: ctx.agentId,
            instructionType: 'followup',
            ...captureInstruction(text),
          },
        });
        return;
      }
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
      // Recorded in both places; either will do, and the longer one is the one
      // that was not already cut by whatever wrote it.
      const brief = longestBrief(r.prompt, spawn?.prompt);
      const followUp = spawn?.resume === r.agentId;
      const captured = captureInstruction(brief);
      events.push({
        ...base(entry),
        agentId: r.agentId,
        agentType,
        parentAgentId: ctx.agentId,
        ...(toolUseId === undefined ? {} : { correlationId: toolUseId }),
        kind: 'agent.started',
        dedupeKey: followUp
          ? dedupeKeys.agentFollowUp(
              r.agentId,
              toolUseId ?? entry.uuid ?? entry.timestamp ?? 'resume',
            )
          : dedupeKeys.agentStarted(r.agentId),
        payload: {
          agentType,
          ...(toolUseId ? { assignmentId: toolUseId } : {}),
          ...(followUp ? { followUp: true } : {}),
          ...(description === undefined ? {} : { description: preview(description) }),
          briefAvailability: captured.availability,
          ...(captured.text
            ? {
                brief: captured.text,
                briefCharCount: captured.charCount,
                briefTruncated: captured.truncated,
              }
            : {}),
          ...((r.resolvedModel ?? spawn?.model) ? { model: r.resolvedModel ?? spawn?.model } : {}),
          spawnMode: r.isAsync === true || r.status === 'async_launched' ? 'async' : 'sync',
          ...(toolUseId === undefined ? {} : { toolUseId }),
        },
      });
      if (r.status === 'completed' && !isFailedResult(entry)) {
        events.push({
          ...base(entry),
          agentId: r.agentId,
          agentType,
          parentAgentId: ctx.agentId,
          ...(toolUseId ? { correlationId: toolUseId } : {}),
          kind: 'agent.finished',
          dedupeKey:
            followUp && toolUseId
              ? dedupeKeys.agentFollowUpFinished(r.agentId, toolUseId)
              : dedupeKeys.agentFinished(r.agentId),
          payload: {
            outcome: 'ok',
            handedBackTo: ctx.agentId,
            ...(toolUseId ? { assignmentId: toolUseId } : {}),
            ...resultDetails(nativeAgentResult(r)),
          },
        });
      }
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

  // Monetary values are native cumulative session snapshots, not estimates.
  // cost-state has no timestamp: use its preceding dated record, conservatively,
  // so reparsing an old file cannot make an old charge appear newly measured.
  if (isMain) {
    const identity = conversational.find((entry) => entry.sessionId && entry.cwd);
    let previousTimestamp: string | undefined;
    for (const [index, entry] of entries.entries()) {
      if (entry.timestamp && Number.isFinite(Date.parse(entry.timestamp)))
        previousTimestamp = entry.timestamp;
      const report =
        entry.usageReport && typeof entry.usageReport === 'object'
          ? (entry.usageReport as Record<string, unknown>)
          : undefined;
      const session =
        report?.session && typeof report.session === 'object'
          ? (report.session as Record<string, unknown>)
          : undefined;
      const cost = entry.type === 'cost-state' ? entry.totalCostUSD : session?.total_cost_usd;
      if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || !previousTimestamp)
        continue;
      const sessionId = entry.sessionId ?? identity?.sessionId;
      if (!sessionId || (identity?.sessionId && identity.sessionId !== sessionId)) continue;
      events.push({
        ts: previousTimestamp,
        source: 'transcript',
        sessionId,
        projectPath: entry.cwd ?? identity?.cwd ?? '',
        agentId: MAIN_AGENT_ID,
        kind: 'usage.updated',
        dedupeKey: `usage.cost:${sessionId}:${entry.uuid ?? index}`,
        payload: { scope: 'session', tokens: emptyTokenUsage(), costUsd: cost },
      });
    }
  }
  return events;
};

/** Only successful paired calls are facts about the agent's execution checklist. */
const emitWorkPlans = (
  streams: readonly {
    agentId: string;
    assignmentId?: string;
    entries: readonly TranscriptEntry[];
  }[],
): DraftEvent[] => {
  const events: DraftEvent[] = [];
  const plans = new ConfirmedClaudePlans();
  const prompts = new Map<string, { promptId?: string; scopeId?: string }>();
  const calls = new Map<
    string,
    {
      owner: string;
      entry: TranscriptEntry;
      name: string;
      input: unknown;
      promptId?: string;
      scopeId?: string;
    }
  >();
  const ordered = streams
    .flatMap(({ agentId, entries }) => entries.map((entry) => ({ agentId, entry })))
    .sort((a, b) => (a.entry.timestamp ?? '').localeCompare(b.entry.timestamp ?? ''));
  const agents = new Set(streams.map((stream) => stream.agentId));
  const recipientByCall = new Map<string, string>();
  for (const stream of streams)
    if (stream.assignmentId) recipientByCall.set(stream.assignmentId, stream.agentId);
  for (const { entry } of ordered) {
    const recipient = agentToolResultSchema.safeParse(entry.toolUseResult);
    if (!recipient.success || !agents.has(recipient.data.agentId)) continue;
    const block = contentBlocks(entry).find((block) => block.type === 'tool_result');
    if (typeof block?.tool_use_id === 'string')
      recipientByCall.set(block.tool_use_id, recipient.data.agentId);
  }
  const assignments = new Map<string, { id: string; ts: string; sourceUuid?: string }[]>();
  for (const { entry } of ordered) {
    for (const block of toolUseBlocks(entry)) {
      if (block.name !== 'Agent' && block.name !== 'Task') continue;
      const input =
        typeof block.input === 'object' && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      const recipient =
        typeof input.resume === 'string' && agents.has(input.resume)
          ? input.resume
          : recipientByCall.get(block.id);
      if (!recipient) continue;
      const history = assignments.get(recipient) ?? [];
      history.push({
        id: block.id,
        ts: entry.timestamp ?? '',
        ...(entry.uuid ? { sourceUuid: entry.uuid } : {}),
      });
      assignments.set(recipient, history);
    }
  }
  // Partial transcript flushes can repeat the same result. Prefer its last
  // recorded copy so an earlier input fallback cannot hide applied native data.
  const latestResults = new Map<string, Record<string, unknown>>();
  for (const { entry } of ordered) {
    if (entry.type !== 'user') continue;
    for (const block of contentBlocks(entry))
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string')
        latestResults.set(block.tool_use_id, block);
  }
  for (const { agentId, entry } of ordered) {
    const blocks = contentBlocks(entry);
    const prompt = prompts.get(agentId) ?? {};
    const assignment = assignments
      .get(agentId)
      ?.findLast(
        (assignment) =>
          assignment.ts <= (entry.timestamp ?? '') ||
          (entry.sourceToolAssistantUUID &&
            assignment.sourceUuid === entry.sourceToolAssistantUUID),
      );
    const initialAssignment = streams.find((stream) => stream.agentId === agentId)?.assignmentId;
    if (assignment || initialAssignment) prompt.scopeId = assignment?.id ?? initialAssignment;
    if (
      entry.type === 'user' &&
      entry.isMeta !== true &&
      entry.toolUseResult === undefined &&
      !blocks.some((block) => block.type === 'tool_result') &&
      !/^\s*<teammate-message\b/.test(promptText(entry)) &&
      !isInjectedMessage(promptText(entry))
    ) {
      if (entry.promptId) prompt.promptId = entry.promptId;
      if (
        !assignment &&
        !initialAssignment &&
        (!prompt.scopeId || !isTaskContinuation(stripEditorContext(promptText(entry))))
      )
        prompt.scopeId = entry.promptId ?? entry.uuid ?? entry.timestamp;
      prompts.set(agentId, prompt);
    }
    if (entry.type === 'assistant') {
      for (const block of toolUseBlocks(entry)) {
        if (
          !['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'Write', 'Edit', 'Bash'].includes(
            block.name,
          )
        )
          continue;
        calls.set(block.id, {
          owner: agentId,
          entry,
          name: block.name,
          input: block.input,
          ...(prompt.promptId ? { promptId: prompt.promptId } : {}),
          ...(prompt.scopeId ? { scopeId: prompt.scopeId } : {}),
        });
      }
      continue;
    }
    if (entry.type !== 'user') continue;
    const results = blocks.filter(
      (block) => block.type === 'tool_result' && typeof block.tool_use_id === 'string',
    );
    for (const block of results) {
      const id = block.tool_use_id as string;
      const call = calls.get(id);
      if (!call || latestResults.get(id) !== block) continue;
      // An entry-level structured result belongs to a single result block.
      // Parallel serialized results can confirm TodoWrite input snapshots, but
      // must never borrow another result's structured TaskCreate/List output.
      const output = results.length === 1 ? entry.toolUseResult : undefined;
      if (block.is_error === true || failedWorkPlanResult(output)) continue;
      if (
        !entry.timestamp ||
        !Number.isFinite(Date.parse(entry.timestamp)) ||
        (entry.sessionId && call.entry.sessionId && entry.sessionId !== call.entry.sessionId)
      )
        continue;
      const sessionId = call.entry.sessionId ?? entry.sessionId;
      if (!sessionId) continue;
      const payload = plans.confirm({
        toolName: call.name,
        input: call.input,
        output,
        sessionId,
        agentId: call.owner,
        projectPath: call.entry.cwd ?? entry.cwd ?? '',
        ...(call.scopeId ? { scopeId: call.scopeId } : {}),
      });
      if (!payload) continue;
      events.push({
        ts: entry.timestamp,
        source: 'transcript',
        sessionId,
        projectPath: call.entry.cwd ?? entry.cwd ?? '',
        agentId: call.owner,
        ...(call.promptId ? { promptId: call.promptId } : {}),
        correlationId: id,
        dedupeKey: dedupeKeys.taskPlan(id, call.owner),
        kind: 'task.plan.updated',
        payload,
      });
    }
  }
  // Establish ownership from confirmed snapshots before emitting any of them.
  // A shared project checklist describes the main assignment; a child that
  // edits it has not thereby completed every sibling's work. Collecting first
  // also handles a child write recorded before the main agent's first write.
  const fileKey = (event: Extract<DraftEvent, { kind: 'task.plan.updated' }>) =>
    JSON.stringify([event.sessionId, resolve(event.projectPath), event.payload.sourceFile]);
  const fileOwners = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.kind !== 'task.plan.updated' || event.payload.sourceTool !== 'Markdown') continue;
    const key = fileKey(event);
    const owners = fileOwners.get(key) ?? new Set<string>();
    owners.add(event.agentId);
    fileOwners.set(key, owners);
  }
  return events.map((event) =>
    event.kind === 'task.plan.updated' &&
    event.payload.sourceTool === 'Markdown' &&
    event.agentId !== MAIN_AGENT_ID &&
    (fileOwners.get(fileKey(event))?.size ?? 0) > 1
      ? { ...event, payload: { ...event.payload, completeness: 'partial' } }
      : event,
  );
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
      if (block.name !== 'Agent' && block.name !== 'Task') continue;
      const input = (
        typeof block.input === 'object' && block.input !== null ? block.input : {}
      ) as Record<string, unknown>;
      spawnInfoByToolUseId.set(block.id, {
        ...(typeof input.subagent_type === 'string' ? { subagentType: input.subagent_type } : {}),
        ...(typeof input.description === 'string' ? { description: input.description } : {}),
        ...(typeof input.model === 'string' ? { model: input.model } : {}),
        ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
        ...(typeof input.resume === 'string' ? { resume: input.resume } : {}),
        ...(typeof input.name === 'string' ? { name: input.name } : {}),
        ...(typeof input.run_in_background === 'boolean'
          ? { background: input.run_in_background }
          : {}),
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

  const agentIdByRecipient = new Map<string, string>([[MAIN_AGENT_ID, MAIN_AGENT_ID]]);
  for (const sub of subagents) agentIdByRecipient.set(sub.agentId, sub.agentId);
  const ambiguous = new Set<string>();
  for (const entry of [...main.entries, ...subagents.flatMap((sub) => sub.entries)]) {
    const result = agentToolResultSchema.safeParse(entry.toolUseResult);
    if (!result.success) continue;
    const agentId = result.data.agentId;
    agentIdByRecipient.set(agentId, agentId);
    const block = contentBlocks(entry).find((block) => block.type === 'tool_result');
    const spawn =
      typeof block?.tool_use_id === 'string'
        ? spawnInfoByToolUseId.get(block.tool_use_id)
        : undefined;
    if (spawn?.name) {
      const previous = agentIdByRecipient.get(spawn.name);
      if (previous && previous !== agentId) ambiguous.add(spawn.name);
      else agentIdByRecipient.set(spawn.name, agentId);
    }
  }
  for (const name of ambiguous) agentIdByRecipient.delete(name);
  const sourceOwnerByUuid = new Map<string, string>();
  for (const entry of main.entries)
    if (entry.uuid) sourceOwnerByUuid.set(entry.uuid, MAIN_AGENT_ID);
  for (const sub of subagents)
    for (const entry of sub.entries) if (entry.uuid) sourceOwnerByUuid.set(entry.uuid, sub.agentId);
  const instructionCopies = new Set<string>();
  const recipientByTool = new Map<string, string>();
  for (const sub of subagents)
    if (sub.meta.toolUseId) recipientByTool.set(sub.meta.toolUseId, sub.agentId);
  const allEntries = [...main.entries, ...subagents.flatMap((sub) => sub.entries)];
  for (const entry of allEntries) {
    const result = agentToolResultSchema.safeParse(entry.toolUseResult);
    const block = contentBlocks(entry).find((block) => block.type === 'tool_result');
    if (result.success && typeof block?.tool_use_id === 'string')
      recipientByTool.set(block.tool_use_id, result.data.agentId);
  }
  const assignmentIdAt = (agentId: string, at: string, fallback?: string): string | undefined => {
    let assignmentId = fallback;
    let latest = '';
    for (const entry of allEntries) {
      if (!entry.timestamp || entry.timestamp > at || entry.timestamp < latest) continue;
      for (const block of toolUseBlocks(entry)) {
        if (block.name !== 'Agent' && block.name !== 'Task') continue;
        if (
          recipientByTool.get(block.id) !== agentId &&
          spawnInfoByToolUseId.get(block.id)?.resume !== agentId
        )
          continue;
        assignmentId = block.id;
        latest = entry.timestamp;
      }
    }
    return assignmentId;
  };
  for (const entry of allEntries) {
    if (!entry.uuid) continue;
    for (const block of toolUseBlocks(entry)) {
      const input =
        typeof block.input === 'object' && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      if (block.name === 'Agent' || block.name === 'Task') {
        const recipient = recipientByTool.get(block.id);
        if (recipient) instructionCopies.add(`${recipient}|${entry.uuid}`);
      } else if (
        block.name === 'SendMessage' &&
        (input.type === undefined || input.type === 'message' || input.type === 'broadcast')
      ) {
        const recipients =
          input.type === 'broadcast'
            ? [...new Set(agentIdByRecipient.values())]
            : typeof input.recipient === 'string'
              ? [agentIdByRecipient.get(input.recipient)]
              : [];
        for (const recipient of recipients)
          if (recipient) instructionCopies.add(`${recipient}|${entry.uuid}`);
      }
    }
  }
  const shared = {
    instructionCopies,
    sourceOwnerByUuid,
    toolNameById,
    spawnInfoByToolUseId,
    agentTypeByAgentId,
    agentIdByRecipient,
    warnings,
  };
  const events = emitForEntries(main.entries, { agentId: MAIN_AGENT_ID, ...shared });
  // Index starts from every parent file before recovering children's copies;
  // directory ordering must not create an extra launch for nested children.
  for (const sub of subagents) {
    const parent = sub.meta.toolUseId ? ownerByToolUseId.get(sub.meta.toolUseId) : undefined;
    events.push(
      ...emitForEntries(sub.entries, {
        agentId: sub.agentId,
        parentAgentId: parent ?? MAIN_AGENT_ID,
        ...(sub.meta.agentType ? { agentType: sub.meta.agentType } : {}),
        ...shared,
      }),
    );
  }
  events.push(
    ...emitWorkPlans([
      { agentId: MAIN_AGENT_ID, entries: main.entries },
      ...subagents.map((sub) => ({
        agentId: sub.agentId,
        ...(sub.meta.toolUseId ? { assignmentId: sub.meta.toolUseId } : {}),
        entries: sub.entries,
      })),
    ]),
  );

  // The authoritative end of each subagent, keyed by agent id. Only ids that are
  // subagents of this session count: the same notification also reports
  // background shells, which are not agents and have no card.
  const known = new Set(subagents.map((sub) => sub.agentId));
  // The notification entry carries a timestamp and nothing else about where it
  // belongs — no sessionId, no cwd. Those come from the session's own entries.
  const identity = main.entries.find(
    (entry) => (entry.type === 'user' || entry.type === 'assistant') && entry.sessionId,
  );
  const notified = new Map<
    string,
    { entry: TranscriptEntry; outcome: 'ok' | 'error' | 'interrupted'; resultText?: string }
  >();
  for (const entry of main.entries) {
    const note = taskNotificationOf(entry);
    if (note && known.has(note.taskId) && !notified.has(note.taskId)) {
      notified.set(note.taskId, {
        entry,
        outcome: note.outcome,
        ...(note.resultText ? { resultText: note.resultText } : {}),
      });
    }
  }

  for (const sub of subagents) {
    const meta = sub.meta as SubagentMeta;
    const parentAgentId = meta.toolUseId ? ownerByToolUseId.get(meta.toolUseId) : undefined;
    if (meta.toolUseId && !parentAgentId) {
      warnings.push(
        `agent ${sub.agentId}: spawning tool use ${meta.toolUseId} not found in session`,
      );
    }

    // The child's first user entry is the parent's assignment, not a human
    // prompt. Recover it when a launch result is absent or was already cut.
    const first = sub.entries.find((entry) => entry.type === 'user' || entry.type === 'assistant');
    const childBrief =
      first?.type === 'user' &&
      !first.parentUuid &&
      first.isMeta !== true &&
      first.toolUseResult === undefined &&
      !contentBlocks(first).some((block) => block.type === 'tool_result') &&
      !isInjectedMessage(promptText(first)) &&
      !/^\s*<teammate-message\b/.test(promptText(first))
        ? promptText(first)
        : undefined;
    const initial = events.find(
      (event) =>
        event.kind === 'agent.started' && event.agentId === sub.agentId && !event.payload.followUp,
    );
    const spawn = meta.toolUseId ? spawnInfoByToolUseId.get(meta.toolUseId) : undefined;
    const fallbackBrief = longestBrief(spawn?.prompt, childBrief);
    const captured = captureInstruction(fallbackBrief);
    if (
      initial?.kind === 'agent.started' &&
      captured.text &&
      (initial.payload.briefAvailability !== 'captured' ||
        (captured.charCount ?? 0) > (initial.payload.briefCharCount ?? 0))
    ) {
      initial.payload.briefAvailability = 'captured';
      initial.payload.brief = captured.text;
      initial.payload.briefCharCount = captured.charCount;
      initial.payload.briefTruncated = captured.truncated;
    } else if (!initial && first && captured.text && (first.sessionId ?? identity?.sessionId)) {
      events.push({
        ts: first.timestamp ?? new Date(0).toISOString(),
        source: 'transcript',
        sessionId: first.sessionId ?? identity?.sessionId ?? '',
        projectPath: first.cwd ?? identity?.cwd ?? '',
        agentId: sub.agentId,
        ...(parentAgentId ? { parentAgentId } : {}),
        ...(first.promptId ? { promptId: first.promptId } : {}),
        ...(meta.toolUseId ? { correlationId: meta.toolUseId } : {}),
        kind: 'agent.started',
        dedupeKey: dedupeKeys.agentStarted(sub.agentId),
        payload: {
          agentType: meta.agentType ?? spawn?.subagentType ?? 'unknown',
          ...(meta.toolUseId ? { assignmentId: meta.toolUseId } : {}),
          briefAvailability: 'captured',
          brief: captured.text,
          briefCharCount: captured.charCount,
          briefTruncated: captured.truncated,
          ...((meta.description ?? spawn?.description)
            ? { description: preview(meta.description ?? spawn?.description) }
            : {}),
          ...((meta.model ?? spawn?.model) ? { model: meta.model ?? spawn?.model } : {}),
          ...(meta.toolUseId ? { toolUseId: meta.toolUseId } : {}),
          spawnMode: spawn && spawn.background !== true ? 'sync' : 'async',
        },
      });
    }

    // Heuristic, and marked as one: a file whose last entry is an assistant
    // `end_turn` is a finished agent. The SubagentStop hook is authoritative when
    // the daemon was running; this is what makes replay-from-disk work when it
    // was not.
    // The notification below is authoritative. This heuristic also misses every
    // subagent that hands back through a tool rather than a final message.
    const note = notified.get(sub.agentId);
    if (note && (identity?.sessionId ?? note.entry.sessionId)) {
      const lastConversation = sub.entries.findLast(
        (entry) =>
          (entry.type === 'user' || entry.type === 'assistant') &&
          (entry.timestamp ?? '') <= (note.entry.timestamp ?? ''),
      );
      const resultText = note.resultText ?? finalAssistantResult(lastConversation);
      const assignmentId = assignmentIdAt(sub.agentId, note.entry.timestamp ?? '', meta.toolUseId);
      events.push({
        ts: note.entry.timestamp ?? new Date(0).toISOString(),
        source: 'transcript',
        sessionId: identity?.sessionId ?? note.entry.sessionId ?? '',
        projectPath: identity?.cwd ?? note.entry.cwd ?? '',
        agentId: sub.agentId,
        ...(meta.agentType === undefined ? {} : { agentType: meta.agentType }),
        parentAgentId: parentAgentId ?? MAIN_AGENT_ID,
        kind: 'agent.finished',
        dedupeKey: dedupeKeys.agentFinished(sub.agentId),
        payload: {
          outcome: note.outcome,
          handedBackTo: parentAgentId ?? MAIN_AGENT_ID,
          ...(assignmentId ? { assignmentId } : {}),
          ...resultDetails(resultText),
        },
      });
      continue;
    }

    const last = sub.entries.at(-1);
    if (last?.type === 'assistant' && last.message?.stop_reason === 'end_turn') {
      const resultText = finalAssistantResult(last);
      const assignmentId = assignmentIdAt(sub.agentId, last.timestamp ?? '', meta.toolUseId);
      const followUp =
        assignmentId && spawnInfoByToolUseId.get(assignmentId)?.resume === sub.agentId;
      events.push({
        ts: last.timestamp ?? new Date(0).toISOString(),
        source: 'transcript',
        sessionId: last.sessionId ?? '',
        projectPath: last.cwd ?? '',
        agentId: sub.agentId,
        ...(meta.agentType === undefined ? {} : { agentType: meta.agentType }),
        parentAgentId: parentAgentId ?? MAIN_AGENT_ID,
        kind: 'agent.finished',
        dedupeKey: followUp
          ? dedupeKeys.agentFollowUpFinished(sub.agentId, assignmentId)
          : dedupeKeys.agentFinished(sub.agentId),
        payload: {
          outcome: 'ok',
          handedBackTo: parentAgentId ?? MAIN_AGENT_ID,
          ...(assignmentId ? { assignmentId } : {}),
          ...resultDetails(resultText),
        },
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
