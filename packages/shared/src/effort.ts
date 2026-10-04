import { z } from 'zod';

/** Reported settings, never inferred from the model name or token counts. */
export const effortLevelSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
export type EffortLevel = z.infer<typeof effortLevelSchema>;

/** Claude also reports the setting as `{ level: "xhigh" }`. */
export const reportedEffort = (raw: unknown): EffortLevel | undefined => {
  const value = typeof raw === 'object' && raw !== null && 'level' in raw ? raw.level : raw;
  const parsed = effortLevelSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};
