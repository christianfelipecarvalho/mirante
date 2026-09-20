import { z } from 'zod';

/**
 * Lenient schemas for transcript entries.
 *
 * Mirante does not own this format and cannot version it. Every field is
 * optional and unknown keys pass through, so a Claude Code release that adds or
 * renames something degrades one derived event instead of failing the whole
 * session. Validation here is for shape, not for trust.
 */

export const usageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    output_tokens_details: z
      .object({ thinking_tokens: z.number().optional() })
      .passthrough()
      .optional(),
    // `iterations` is deliberately not read: it restates these same totals and
    // summing it double-counts. See docs/EVENT_MAP.md §4.
  })
  .passthrough();

export const toolUseBlockSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown().optional(),
  })
  .passthrough();

export const toolResultBlockSchema = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    is_error: z.boolean().optional(),
    content: z.unknown().optional(),
  })
  .passthrough();

export const textBlockSchema = z
  .object({ type: z.literal('text'), text: z.string().optional() })
  .passthrough();

export const thinkingBlockSchema = z.object({ type: z.literal('thinking') }).passthrough();

export const contentBlockSchema = z.union([
  toolUseBlockSchema,
  toolResultBlockSchema,
  textBlockSchema,
  thinkingBlockSchema,
  z.object({ type: z.string() }).passthrough(),
]);

export const messageSchema = z
  .object({
    role: z.string().optional(),
    model: z.string().optional(),
    stop_reason: z.string().nullish(),
    usage: usageSchema.optional(),
    content: z.union([z.string(), z.array(contentBlockSchema)]).optional(),
  })
  .passthrough();

export const transcriptEntrySchema = z
  .object({
    type: z.string(),
    uuid: z.string().optional(),
    parentUuid: z.string().nullish(),
    timestamp: z.string().optional(),
    sessionId: z.string().optional(),
    cwd: z.string().optional(),
    gitBranch: z.string().optional(),
    version: z.string().optional(),
    entrypoint: z.string().optional(),
    promptId: z.string().optional(),
    isMeta: z.boolean().optional(),
    isSidechain: z.boolean().optional(),
    /** Present only in subagent transcripts. */
    agentId: z.string().optional(),
    /** Active skill on this entry — more direct than inferring from a Skill tool-use block. */
    attributionSkill: z.string().nullish(),
    attributionAgent: z.string().nullish(),
    sourceToolAssistantUUID: z.string().nullish(),
    toolUseResult: z.unknown().optional(),
    message: messageSchema.optional(),
  })
  .passthrough();

export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

/** `<sessionId>/subagents/agent-<agentId>.meta.json` */
export const subagentMetaSchema = z
  .object({
    agentType: z.string().optional(),
    description: z.string().optional(),
    /**
     * The parent's `Agent` tool-use id. This is the handoff edge — it matches a
     * tool-use block in the spawning transcript exactly, so the parent-child link
     * needs no inference. See ADR-0004.
     */
    toolUseId: z.string().optional(),
    spawnDepth: z.number().optional(),
    model: z.string().optional(),
  })
  .passthrough();

export type SubagentMeta = z.infer<typeof subagentMetaSchema>;

/** The `toolUseResult` shape of an `Agent` call in the parent transcript. */
export const agentToolResultSchema = z
  .object({
    agentId: z.string(),
    status: z.string().optional(),
    isAsync: z.boolean().optional(),
    resolvedModel: z.string().optional(),
    description: z.string().optional(),
    outputFile: z.string().optional(),
  })
  .passthrough();
