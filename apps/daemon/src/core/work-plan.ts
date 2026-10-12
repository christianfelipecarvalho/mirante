import { MAIN_AGENT_ID, type TaskPlan } from '@mirante/shared';
import { scrubSecrets } from './redact.js';

type WorkPlanStep = TaskPlan['steps'][number];

/** Reject incomplete snapshots as a whole; never silently drop or truncate steps. */
export const normalizeWorkPlan = (input: unknown): WorkPlanStep[] | undefined => {
  if (!Array.isArray(input) || input.length > 500) return undefined;
  const steps: WorkPlanStep[] = [];
  const ids = new Set<string>();
  for (const value of input) {
    const step = record(value);
    if (!step || typeof step.id !== 'string' || typeof step.text !== 'string') return undefined;
    const id = scrubSecrets(step.id).trim();
    const text = scrubSecrets(step.text).replace(/\s+/g, ' ').trim();
    if (!id || id.length > 200 || ids.has(id) || !text || text.length > 4000) return undefined;
    if (!isStatus(step.status)) return undefined;
    ids.add(id);
    steps.push({ id, text, status: step.status });
  }
  return steps;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const isStatus = (value: unknown): value is WorkPlanStep['status'] =>
  value === 'pending' || value === 'in_progress' || value === 'completed';

const localTaskOwner = (owner: unknown, agentId: string): boolean =>
  owner === undefined || owner === '' || owner === agentId;

/** Read only structured native output, never task-like prose or delegation tools. */
export const failedWorkPlanResult = (value: unknown): boolean => {
  const output = record(value);
  return output?.success === false || output?.interrupted === true || output?.is_error === true;
};

type ConfirmedPlanInput = {
  toolName: string;
  input: unknown;
  output: unknown;
  sessionId: string;
  agentId: string;
  scopeId?: string;
};

/**
 * Native formats: Claude Code 2.1.296's sdk-tools.d.ts and the Agent SDK docs.
 * Call only after a paired successful result or a confirmed PostToolUse hook.
 * TaskCreate/TaskUpdate cover observed IDs; only TaskList establishes coverage.
 * https://code.claude.com/docs/en/agent-sdk/todo-tracking
 */
export class ConfirmedClaudePlans {
  private readonly views = new Map<string, { steps: WorkPlanStep[]; complete: boolean }>();

  confirm(context: ConfirmedPlanInput): TaskPlan | undefined {
    const { toolName, sessionId, agentId, scopeId } = context;
    if (!['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList'].includes(toolName)) return undefined;
    if (failedWorkPlanResult(context.output)) return undefined;
    const input = record(context.input);
    const output = record(context.output);
    const family = toolName === 'TodoWrite' ? 'todos' : 'tasks';
    const planId = `claude:${family}:${sessionId}:${agentId}:${scopeId ?? 'session'}`;
    const previous = this.views.get(planId);
    const snapshot = (steps: WorkPlanStep[], complete: boolean): TaskPlan => {
      this.views.set(planId, { steps, complete });
      return {
        planId,
        ...(scopeId ? { scopeId } : {}),
        sourceTool: toolName as TaskPlan['sourceTool'],
        completeness: complete ? 'full' : 'partial',
        steps,
      };
    };
    const uncertainMutation = (): TaskPlan | undefined => {
      // A successful write can change rows we cannot read. Tell the projector
      // that the previously observed rows no longer prove complete coverage.
      // TaskList is read-only: an unreadable read does not invalidate a known
      // earlier snapshot. Failed writes returned before reaching this branch.
      if (toolName === 'TaskList' || !previous?.complete) return undefined;
      return snapshot(previous.steps, false);
    };
    let steps: WorkPlanStep[] | undefined;
    let complete = previous?.complete ?? false;

    if (toolName === 'TodoWrite') {
      // Output is the applied snapshot; input is sufficient when the result is
      // serialized text rather than structured output. An invalid native output
      // must not fall back to a possibly unapplied input snapshot.
      const todos = output && 'newTodos' in output ? output.newTodos : input?.todos;
      steps = normalizeWorkPlan(
        Array.isArray(todos)
          ? todos.map((todo, index) => {
              const item = record(todo);
              return { id: `step-${index + 1}`, text: item?.content, status: item?.status };
            })
          : undefined,
      );
      complete = true;
    } else if (toolName === 'TaskList') {
      steps = normalizeWorkPlan(
        Array.isArray(output?.tasks)
          ? output.tasks.map((task) => {
              const item = record(task);
              return { id: item?.id, text: item?.subject, status: item?.status };
            })
          : undefined,
      );
      // Team TaskList snapshots can include other agents' work. Keep all rows
      // as partial evidence for a child unless ownership is explicitly local
      // or absent; native teammate handles are never guessed to be UUIDs.
      // https://code.claude.com/docs/en/agent-teams#assign-and-claim-tasks
      complete =
        agentId === MAIN_AGENT_ID ||
        (Array.isArray(output?.tasks) &&
          output.tasks.every((task) => localTaskOwner(record(task)?.owner, agentId)));
    } else if (toolName === 'TaskCreate') {
      const task = record(output?.task);
      const created = normalizeWorkPlan([
        { id: task?.id, text: task?.subject, status: 'pending' },
      ])?.[0];
      if (created) {
        steps = [...(previous?.steps ?? []).filter((step) => step.id !== created.id), created];
      }
    } else if (output?.success === true && typeof output.taskId === 'string') {
      const id = input?.taskId ?? input?.id ?? input?.task_id;
      // Claude repairs aliases before execution. The returned taskId is the
      // authoritative ID, but a contradictory input is not safe to attribute.
      if (id !== undefined && id !== output.taskId) return uncertainMutation();
      if (!Array.isArray(output.updatedFields)) return uncertainMutation();
      const updatedFields = output.updatedFields;
      if (
        agentId !== MAIN_AGENT_ID &&
        updatedFields.includes('owner') &&
        (!input || !('owner' in input) || !localTaskOwner(input.owner, agentId))
      )
        complete = false;
      const statusChange = record(output.statusChange);
      const nativeStatus =
        statusChange?.to ?? (updatedFields.includes('status') ? input?.status : undefined);
      const existing = previous?.steps.find((step) => step.id === output.taskId);
      if (nativeStatus === 'deleted') {
        if (existing) steps = previous?.steps.filter((step) => step.id !== existing.id);
      } else {
        const changed = normalizeWorkPlan([
          {
            id: output.taskId,
            text: updatedFields.includes('subject') ? input?.subject : existing?.text,
            status: nativeStatus ?? existing?.status,
          },
        ])?.[0];
        if (changed) {
          // A previously unknown ID makes earlier coverage stale unless the
          // native list was read again. A status-only update cannot invent text.
          if (!existing) complete = false;
          steps = existing
            ? previous?.steps.map((step) => (step.id === changed.id ? changed : step))
            : [...(previous?.steps ?? []), changed];
        }
      }
    }

    steps = normalizeWorkPlan(steps);
    return steps ? snapshot(steps, complete) : uncertainMutation();
  }
}
