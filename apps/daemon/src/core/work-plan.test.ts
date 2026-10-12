import { describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, workProgress } from '@mirante/shared';
import { ConfirmedClaudePlans } from './work-plan.js';

const context = { sessionId: 'session', agentId: 'child', scopeId: 'assignment' };
const completeList = {
  ...context,
  toolName: 'TaskList',
  input: {},
  output: { tasks: [{ id: '7', subject: 'Observed task', status: 'completed', blockedBy: [] }] },
};

describe('coverage changes after confirmed native writes', () => {
  it.each([
    {
      toolName: 'TaskUpdate',
      input: { taskId: '9', status: 'completed' },
      output: {
        success: true,
        taskId: '9',
        updatedFields: ['status'],
        statusChange: { from: 'pending', to: 'completed' },
      },
    },
    {
      toolName: 'TaskCreate',
      input: { subject: 'Unobserved task' },
      output: { task: { id: '9' } },
    },
    {
      toolName: 'TaskUpdate',
      input: { taskId: '7', status: 'completed' },
      output: { success: true, taskId: '7' },
    },
    {
      toolName: 'TaskUpdate',
      input: { taskId: 'other', status: 'completed' },
      output: { success: true, taskId: '7', updatedFields: ['status'] },
    },
  ])(
    'downgrades a previously complete view after an unreadable successful $toolName write',
    (mutation) => {
      const plans = new ConfirmedClaudePlans();
      const before = plans.confirm(completeList);
      expect(before?.completeness).toBe('full');
      expect(
        before && workProgress({ ...before, updatedAt: '2026-09-01T00:00:00.000Z' }).percent,
      ).toBe(100);
      const after = plans.confirm({ ...context, ...mutation });
      expect(after).toMatchObject({
        planId: before?.planId,
        scopeId: 'assignment',
        completeness: 'partial',
        steps: [{ id: '7', text: 'Observed task', status: 'completed' }],
      });
      expect(
        after && workProgress({ ...after, updatedAt: '2026-09-01T00:00:01.000Z' }).percent,
      ).toBeUndefined();
      expect(plans.confirm(completeList)?.completeness).toBe('full');
    },
  );

  it('downgrades unreadable applied TodoWrite snapshots without inventing new rows', () => {
    const plans = new ConfirmedClaudePlans();
    const before = plans.confirm({
      ...context,
      toolName: 'TodoWrite',
      input: {},
      output: {
        newTodos: [{ content: 'Observed task', status: 'completed', activeForm: 'Working' }],
      },
    });
    const after = plans.confirm({
      ...context,
      toolName: 'TodoWrite',
      input: { todos: [{ content: 'Proposed task', status: 'pending', activeForm: 'Working' }] },
      output: { newTodos: [{ content: 'Unknown status', status: 'done' }] },
    });
    expect(after).toMatchObject({
      planId: before?.planId,
      sourceTool: 'TodoWrite',
      completeness: 'partial',
      steps: before?.steps,
    });
    expect(
      after && workProgress({ ...after, updatedAt: '2026-09-01T00:00:01.000Z' }).percent,
    ).toBeUndefined();
  });

  it('preserves confirmed coverage across failed writes and unreadable read-only TaskList results', () => {
    const plans = new ConfirmedClaudePlans();
    plans.confirm(completeList);
    expect(
      plans.confirm({ ...context, toolName: 'TaskCreate', input: {}, output: { success: false } }),
    ).toBeUndefined();
    expect(
      plans.confirm({ ...context, toolName: 'TaskList', input: {}, output: { tasks: [null] } }),
    ).toBeUndefined();
    const after = plans.confirm({
      ...context,
      toolName: 'TaskUpdate',
      input: { taskId: '7', subject: 'Updated task' },
      output: { success: true, taskId: '7', updatedFields: ['subject'] },
    });
    expect(after).toMatchObject({
      completeness: 'full',
      steps: [{ id: '7', text: 'Updated task', status: 'completed' }],
    });
    expect(after && workProgress({ ...after, updatedAt: '2026-09-01T00:00:01.000Z' }).percent).toBe(
      100,
    );
  });

  it('does not manufacture a view when no earlier snapshot was observed', () => {
    const plans = new ConfirmedClaudePlans();
    expect(
      plans.confirm({
        ...context,
        toolName: 'TaskCreate',
        input: {},
        output: { task: { id: '9' } },
      }),
    ).toBeUndefined();
    expect(
      plans.confirm({ ...context, toolName: 'TodoWrite', input: {}, output: { newTodos: [null] } }),
    ).toBeUndefined();
  });
});

describe('native task ownership in shared team lists', () => {
  const ownedList = (owner?: string) => ({
    ...completeList,
    output: {
      tasks: [{ ...completeList.output.tasks[0], ...(owner === undefined ? {} : { owner }) }],
    },
  });

  it.each(['child-b', 'teammate-handle'])(
    'keeps %s task rows partial for another child without guessing identity',
    (owner) => {
      const plans = new ConfirmedClaudePlans();
      const shared = plans.confirm(ownedList(owner));
      expect(shared).toMatchObject({
        completeness: 'partial',
        steps: [{ id: '7', text: 'Observed task', status: 'completed' }],
      });
      expect(
        shared && workProgress({ ...shared, updatedAt: '2026-09-01T00:00:00.000Z' }).percent,
      ).toBeUndefined();
      const isolated = plans.confirm(ownedList(context.agentId));
      expect(isolated?.completeness).toBe('full');
      expect(
        isolated && workProgress({ ...isolated, updatedAt: '2026-09-01T00:00:01.000Z' }).percent,
      ).toBe(100);
    },
  );

  it.each([undefined, ''])(
    'allows ownerless native TaskList snapshots to establish complete coverage (%#)',
    (owner) => {
      const plans = new ConfirmedClaudePlans();
      plans.confirm(ownedList('another-child'));
      expect(plans.confirm(ownedList(owner))?.completeness).toBe('full');
    },
  );

  it('retains a complete global view for the main agent', () => {
    const plan = new ConfirmedClaudePlans().confirm({
      ...ownedList('another-child'),
      agentId: MAIN_AGENT_ID,
    });
    expect(plan?.completeness).toBe('full');
    expect(plan && workProgress({ ...plan, updatedAt: '2026-09-01T00:00:00.000Z' }).percent).toBe(
      100,
    );
  });

  it('downgrades a confirmed ownership transfer and restores coverage only after an isolated TaskList', () => {
    const plans = new ConfirmedClaudePlans();
    plans.confirm(ownedList(context.agentId));
    const transferred = plans.confirm({
      ...context,
      toolName: 'TaskUpdate',
      input: { taskId: '7', owner: 'another-child' },
      output: { success: true, taskId: '7', updatedFields: ['owner'] },
    });
    expect(transferred).toMatchObject({
      completeness: 'partial',
      steps: [{ id: '7', text: 'Observed task', status: 'completed' }],
    });
    expect(
      transferred &&
        workProgress({ ...transferred, updatedAt: '2026-09-01T00:00:01.000Z' }).percent,
    ).toBeUndefined();
    const reclaimed = plans.confirm({
      ...context,
      toolName: 'TaskUpdate',
      input: { taskId: '7', owner: context.agentId },
      output: { success: true, taskId: '7', updatedFields: ['owner'] },
    });
    expect(reclaimed?.completeness).toBe('partial');
    expect(plans.confirm(ownedList(context.agentId))?.completeness).toBe('full');
  });

  it('preserves coverage when an ownership transfer fails', () => {
    const plans = new ConfirmedClaudePlans();
    plans.confirm(ownedList(context.agentId));
    expect(
      plans.confirm({
        ...context,
        toolName: 'TaskUpdate',
        input: { taskId: '7', owner: 'another-child' },
        output: { success: false, taskId: '7', updatedFields: [] },
      }),
    ).toBeUndefined();
    expect(
      plans.confirm({
        ...context,
        toolName: 'TaskUpdate',
        input: { taskId: '7', subject: 'Renamed task' },
        output: { success: true, taskId: '7', updatedFields: ['subject'] },
      })?.completeness,
    ).toBe('full');
  });
});
