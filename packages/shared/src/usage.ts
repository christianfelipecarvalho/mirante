import { z } from 'zod';

/**
 * Token counts, normalized from `message.usage` in the transcript.
 *
 * Deliberately omits `iterations[]`: that array is a per-iteration breakdown of
 * these same totals, not additional usage. Summing it double-counts. See
 * docs/EVENT_MAP.md §4.
 */
export const tokenUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheCreation: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  /** Subset of `output`, not additive. Reported for display only. */
  thinking: z.number().int().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export const emptyTokenUsage = (): TokenUsage => ({
  input: 0,
  output: 0,
  cacheCreation: 0,
  cacheRead: 0,
});

export const addTokenUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheCreation: a.cacheCreation + b.cacheCreation,
  cacheRead: a.cacheRead + b.cacheRead,
  thinking:
    a.thinking === undefined && b.thinking === undefined
      ? undefined
      : (a.thinking ?? 0) + (b.thinking ?? 0),
});

/** Every token that crossed the wire, cache included. `thinking` is excluded as a subset of `output`. */
export const totalTokens = (u: TokenUsage): number =>
  u.input + u.output + u.cacheCreation + u.cacheRead;

/**
 * One plan limit window from the status line.
 *
 * Absence is meaningful and is never zero: `rate_limits` reaches only Pro and Max
 * subscribers, only after the first API response of a session, and never with an
 * API key. Claude Code also drops a window once its `resetsAt` has passed.
 */
export const planWindowSchema = z.object({
  usedPercentage: z.number().min(0),
  /** Unix epoch seconds, as Claude Code reports it. */
  resetsAt: z.number().int().positive().optional(),
});
export type PlanWindow = z.infer<typeof planWindowSchema>;

/**
 * How long a plan reading can stand for the present.
 *
 * Claude Code's own figure: it stops trusting its cached reading after an hour.
 * The daemon refuses older cached figures, the overlay stops asserting a limit
 * it cannot date, and the interface marks older readings as stale.
 */
export const PLAN_READING_MAX_AGE_MS = 60 * 60 * 1000;

export const planUsageSchema = z.object({
  fiveHour: planWindowSchema.optional(),
  sevenDay: planWindowSchema.optional(),
  spendLimit: planWindowSchema.optional(),
});
export type PlanUsage = z.infer<typeof planUsageSchema>;

export const contextUsageSchema = z.object({
  usedPercentage: z.number().min(0).max(100),
  contextWindowSize: z.number().int().positive(),
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  exceeds200k: z.boolean().optional(),
});
export type ContextUsage = z.infer<typeof contextUsageSchema>;
