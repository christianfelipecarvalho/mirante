import { z } from 'zod';

/** Execution checklists are independent of account subscription limits. */
export const taskPlanPayload = z
  .object({
    planId: z.string().min(1),
    scopeId: z.string().min(1).optional(),
    sourceTool: z.enum([
      'update_plan',
      'TodoWrite',
      'TaskCreate',
      'TaskUpdate',
      'TaskList',
      'Markdown',
    ]),
    /** Explicitly recorded checklist file, relative to the session's project. */
    sourceFile: z.string().min(1).max(4096).optional(),
    completeness: z.enum(['full', 'partial']),
    steps: z
      .array(
        z.object({
          id: z.string().min(1),
          text: z.string().min(1).max(4000),
          status: z.enum(['pending', 'in_progress', 'completed']),
        }),
      )
      .max(500),
  })
  .superRefine((plan, ctx) => {
    if (new Set(plan.steps.map((step) => step.id)).size !== plan.steps.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Plan step IDs must be unique' });
  });

export type TaskPlan = z.infer<typeof taskPlanPayload>;
export type WorkPlan = TaskPlan & { updatedAt: string };

/** Equal step weights: a running step has not been completed yet. */
export const workProgress = (plan?: WorkPlan) => {
  const steps = plan?.steps ?? [];
  const completed = steps.filter((step) => step.status === 'completed').length;
  const inProgress = steps.filter((step) => step.status === 'in_progress').length;
  return {
    total: steps.length,
    completed,
    inProgress,
    pending: steps.length - completed - inProgress,
    percent:
      plan?.completeness === 'full' && steps.length > 0
        ? Math.floor((100 * completed) / steps.length)
        : undefined,
  };
};

/** These replies continue the current assignment rather than replacing it. */
const CONTINUATIONS = new Set([
  'continue',
  'continua',
  'go on',
  'go ahead',
  'proceed',
  'keep going',
  'yes',
  'y',
  'ok',
  'okay',
  'sure',
  'do it',
  'sim',
  's',
  'pode',
  'pode seguir',
  'pode continuar',
  'pode fazer',
  'pode comecar',
  'segue',
  'siga',
  'prossiga',
  'isso',
  'bora',
  'perfeito',
  'certo',
  'beleza',
  'faca isso',
]);

export const isTaskContinuation = (text: string): boolean => {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 24) return false;
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return true;
  const normalized = trimmed
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return CONTINUATIONS.has(normalized);
};
