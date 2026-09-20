import { z } from 'zod';
import { MAIN_AGENT_ID, emptyTokenUsage, type DraftEvent, type PlanUsage } from '@mirante/shared';

/**
 * The JSON Claude Code pipes to a status line command.
 *
 * This is the only surface that reports plan usage, which is why Mirante wraps
 * the user's status line rather than asking them to give one up.
 */
export const statusLinePayloadSchema = z
  .object({
    session_id: z.string(),
    cwd: z.string().optional(),
    model: z
      .object({ id: z.string().optional(), display_name: z.string().optional() })
      .passthrough()
      .optional(),
    workspace: z
      .object({ current_dir: z.string().optional(), project_dir: z.string().optional() })
      .passthrough()
      .optional(),
    version: z.string().optional(),
    cost: z.object({ total_cost_usd: z.number().optional() }).passthrough().optional(),
    context_window: z
      .object({
        total_input_tokens: z.number().optional(),
        total_output_tokens: z.number().optional(),
        context_window_size: z.number().optional(),
        used_percentage: z.number().optional(),
      })
      .passthrough()
      .optional(),
    exceeds_200k_tokens: z.boolean().optional(),
    rate_limits: z
      .object({
        five_hour: z
          .object({ used_percentage: z.number(), resets_at: z.number().optional() })
          .passthrough()
          .optional(),
        seven_day: z
          .object({ used_percentage: z.number(), resets_at: z.number().optional() })
          .passthrough()
          .optional(),
        spend_limit: z
          .object({ used_percentage: z.number(), resets_at: z.number().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type StatusLinePayload = z.infer<typeof statusLinePayloadSchema>;

const windowOf = (raw: { used_percentage: number; resets_at?: number } | undefined) =>
  raw === undefined
    ? undefined
    : {
        usedPercentage: raw.used_percentage,
        ...(raw.resets_at === undefined ? {} : { resetsAt: raw.resets_at }),
      };

export const statusLineToEvents = (
  payload: StatusLinePayload,
  now = new Date().toISOString(),
): DraftEvent[] => {
  const base = {
    ts: now,
    source: 'statusline' as const,
    sessionId: payload.session_id,
    projectPath: payload.workspace?.project_dir ?? payload.cwd ?? '',
    agentId: MAIN_AGENT_ID,
  };

  const events: DraftEvent[] = [];
  const context = payload.context_window;

  if (payload.cost?.total_cost_usd !== undefined || context) {
    events.push({
      ...base,
      kind: 'usage.updated',
      payload: {
        // Session scope: cost and context occupancy belong to the lane, not to a
        // card. Token counts are not taken from here — the transcript is the
        // source of truth for those, per agent.
        scope: 'session',
        tokens: emptyTokenUsage(),
        ...(payload.cost?.total_cost_usd === undefined
          ? {}
          : { costUsd: payload.cost.total_cost_usd }),
        ...(payload.model?.id ? { model: payload.model.id } : {}),
        ...(context?.used_percentage !== undefined && context.context_window_size !== undefined
          ? {
              context: {
                usedPercentage: Math.min(100, Math.max(0, context.used_percentage)),
                contextWindowSize: context.context_window_size,
                totalInputTokens: context.total_input_tokens ?? 0,
                totalOutputTokens: context.total_output_tokens ?? 0,
                ...(payload.exceeds_200k_tokens === undefined
                  ? {}
                  : { exceeds200k: payload.exceeds_200k_tokens }),
              },
            }
          : {}),
      },
    });
  }

  const usage: PlanUsage = {
    ...(windowOf(payload.rate_limits?.five_hour)
      ? { fiveHour: windowOf(payload.rate_limits?.five_hour)! }
      : {}),
    ...(windowOf(payload.rate_limits?.seven_day)
      ? { sevenDay: windowOf(payload.rate_limits?.seven_day)! }
      : {}),
    ...(windowOf(payload.rate_limits?.spend_limit)
      ? { spendLimit: windowOf(payload.rate_limits?.spend_limit)! }
      : {}),
  };

  // Absence is meaningful: no subscription, no API response yet, or the window
  // already reset. Emitting an empty object would render as zero usage, which is
  // the opposite of unknown.
  if (Object.keys(usage).length > 0) {
    events.push({ ...base, kind: 'plan.usage.updated', payload: { usage } });
  }

  return events;
};
