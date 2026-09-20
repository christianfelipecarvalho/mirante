import { z } from 'zod';
import { spawnModeSchema } from './agent.js';
import { entrypointSchema } from './kinds.js';
import { cardStatusSchema } from './state.js';
import { contextUsageSchema, planUsageSchema, tokenUsageSchema } from './usage.js';

/**
 * Text lifted from a prompt, a tool input, or an error, already truncated and
 * redacted at ingest. Raw content never reaches an event; see ADR-0005.
 */
const previewSchema = z.string();

export const sessionStartedPayload = z.object({
  entrypoint: entrypointSchema,
  cwd: z.string(),
  claudeVersion: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  /** Set when resuming rather than starting fresh. */
  resumed: z.boolean().optional(),
});

export const sessionEndedPayload = z.object({
  reason: z.string().optional(),
});

export const promptSubmittedPayload = z.object({
  promptId: z.string().optional(),
  preview: previewSchema,
  charCount: z.number().int().nonnegative(),
});

export const agentStartedPayload = z.object({
  agentType: z.string(),
  description: z.string().optional(),
  model: z.string().optional(),
  spawnMode: spawnModeSchema,
  spawnDepth: z.number().int().nonnegative().optional(),
  /**
   * The parent's `Agent` tool-use id. This is the handoff edge: it is recorded in
   * the subagent's `meta.json` and matches a tool-use block in the parent
   * transcript exactly, so the parent-child link needs no inference.
   */
  toolUseId: z.string().optional(),
});

export const agentFinishedPayload = z.object({
  outcome: z.enum(['ok', 'error', 'interrupted']),
  durationMs: z.number().int().nonnegative().optional(),
  resultPreview: previewSchema.optional(),
  /** Who the work went back to. Drives the handoff line in the timeline. */
  handedBackTo: z.string().optional(),
});

export const toolStartedPayload = z.object({
  toolUseId: z.string(),
  toolName: z.string(),
  /** One line for the card: a file path, the head of a command. */
  summary: previewSchema,
});

export const toolFinishedPayload = z.object({
  toolUseId: z.string(),
  toolName: z.string(),
  durationMs: z.number().int().nonnegative().optional(),
});

export const toolFailedPayload = z.object({
  toolUseId: z.string(),
  toolName: z.string(),
  errorPreview: previewSchema,
  durationMs: z.number().int().nonnegative().optional(),
});

export const skillInvokedPayload = z.object({
  skillName: z.string(),
});

export const permissionRequestedPayload = z.object({
  requestId: z.string(),
  toolUseId: z.string().optional(),
  toolName: z.string(),
  inputPreview: previewSchema,
  /**
   * When the daemon stops waiting for a click and answers `ask`, letting the
   * terminal prompt instead. Always earlier than the hook's own timeout: a hook
   * that times out on PreToolUse does not block the call, so nothing may be
   * designed around holding it open. See ARCHITECTURE.md.
   */
  decideBy: z.string().datetime(),
});

export const permissionResolvedPayload = z.object({
  requestId: z.string(),
  decision: z.enum(['allow', 'deny', 'ask']),
  /**
   * `ui` — someone clicked in Mirante.
   * `fallback` — nobody clicked in time and the terminal was asked instead.
   * `external` — resolved outside Mirante, for example by a settings rule.
   */
  via: z.enum(['ui', 'fallback', 'external']),
  reason: z.string().optional(),
});

export const usageUpdatedPayload = z.object({
  /** `agent` is this card's own consumption; `session` is the lane total. */
  scope: z.enum(['agent', 'session']),
  tokens: tokenUsageSchema,
  costUsd: z.number().nonnegative().optional(),
  context: contextUsageSchema.optional(),
  model: z.string().optional(),
});

export const planUsageUpdatedPayload = z.object({
  usage: planUsageSchema,
});

export const contextCompactedPayload = z.object({
  phase: z.enum(['pre', 'post']),
  trigger: z.enum(['auto', 'manual']).optional(),
  tokensBefore: z.number().int().nonnegative().optional(),
  tokensAfter: z.number().int().nonnegative().optional(),
});

export const waitingChangedPayload = z.object({
  status: cardStatusSchema,
  /** The status this card held immediately before, when known. */
  previousState: z.string().optional(),
});

export const errorRaisedPayload = z.object({
  kind: z.enum(['api', 'tool', 'parse', 'internal']),
  message: previewSchema,
  recoverable: z.boolean().optional(),
});
