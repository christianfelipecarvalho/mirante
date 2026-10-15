import { describe, expect, it } from 'vitest';
import { workProgress } from '@mirante/shared';
import {
  MARKDOWN_PLAN_MAX_BYTES,
  markdownPlanSourceFile,
  parseMarkdownPlan,
} from './markdown-plan.js';
import { ConfirmedClaudePlans } from './work-plan.js';

const document =
  '# Plano de implementação\n\n**Progresso: 99%**\n\n- [x] Read code\n- [ ] Implement\n- [ ] Verify\n';
const context = {
  sessionId: 'session',
  agentId: 'main',
  scopeId: 'assignment',
  projectPath: '/tmp/project',
};
const write = (content = document, filePath = '/tmp/project/PLANO-CANVAS.md') => ({
  ...context,
  toolName: 'Write',
  input: { file_path: filePath, content },
  output: { type: 'create', filePath, content, userModified: false },
});
const edit = (
  originalFile = document,
  oldString = '- [ ] Implement',
  newString = '- [x] Implement',
) => ({
  ...context,
  toolName: 'Edit',
  input: {
    file_path: '/tmp/project/PLANO-CANVAS.md',
    old_string: oldString,
    new_string: newString,
  },
  output: {
    filePath: '/tmp/project/PLANO-CANVAS.md',
    originalFile,
    oldString,
    newString,
    replaceAll: false,
    userModified: false,
  },
});

describe('confirmed Markdown execution checklists', () => {
  it('counts applied Write checkboxes instead of claimed percentages or proposed input', () => {
    const call = write();
    call.input.content = '# Plan\n- [x] Proposed finished work';
    const plan = new ConfirmedClaudePlans().confirm(call);
    expect(plan).toMatchObject({
      sourceTool: 'Markdown',
      sourceFile: 'PLANO-CANVAS.md',
      scopeId: 'assignment',
      completeness: 'full',
    });
    expect(workProgress(plan && { ...plan, updatedAt: '2026-10-14T18:00:00Z' }).percent).toBe(33);
  });

  it('reconstructs the full applied Edit snapshot without a previous observed Write', () => {
    const plans = new ConfirmedClaudePlans();
    const before = plans.confirm(write());
    const after = plans.confirm(edit());
    expect(after?.planId).toBe(before?.planId);
    expect(after?.steps.map((step) => step.status)).toEqual(['completed', 'completed', 'pending']);
    expect(workProgress(after && { ...after, updatedAt: '2026-10-14T18:00:00Z' }).percent).toBe(66);
  });

  it('handles explicitly confirmed replace-all while rejecting ambiguous single replacements', () => {
    const original = '# Plan\n- [ ] First\n- [ ] Second\n';
    const call = edit(original, '- [ ]', '- [x]');
    expect(new ConfirmedClaudePlans().confirm(call)).toBeUndefined();
    const plan = new ConfirmedClaudePlans().confirm({
      ...call,
      input: { ...call.input, replace_all: true },
      output: { ...call.output, replaceAll: true },
    });
    expect(plan?.steps.every((step) => step.status === 'completed')).toBe(true);
  });

  it.each([
    { output: undefined },
    { output: { content: document } },
    { output: { ...write().output, success: false } },
    { output: { ...write().output, is_error: true } },
    { output: { ...write().output, userModified: true } },
    { output: { ...write().output, filePath: '/tmp/project/another-plan.md' } },
    { projectPath: undefined },
  ])('does not confirm unpaired, failed, or contradictory writes (%#)', (change) => {
    expect(new ConfirmedClaudePlans().confirm({ ...write(), ...change })).toBeUndefined();
  });

  it.each([
    { originalFile: undefined },
    { originalFile: '# Plan\n- [ ] Different' },
    { replaceAll: undefined },
    { newString: '- [x] Unexpected' },
    { oldString: '' },
  ])('rejects incomplete or inconsistent applied edits (%#)', (change) => {
    const call = edit();
    expect(
      new ConfirmedClaudePlans().confirm({ ...call, output: { ...call.output, ...change } }),
    ).toBeUndefined();
  });

  it('redacts every recorded label and source path before persistence', () => {
    const plan = new ConfirmedClaudePlans().confirm(
      write(
        '# Plano\n- [x] Contact person@example.com with sk-ant-exampleSecretToken12345',
        '/tmp/project/plan-person@example.com.md',
      ),
    );
    expect(plan).toBeDefined();
    expect(JSON.stringify(plan)).not.toContain('person@example.com');
    expect(JSON.stringify(plan)).not.toContain('sk-ant-exampleSecretToken12345');
    expect(plan?.steps[0]?.text).toContain('[redacted]');
    expect(plan?.sourceFile).toBeUndefined();
  });

  it('keeps independently owned plans and distinct assignments separate', () => {
    const plans = new ConfirmedClaudePlans();
    const base = plans.confirm(write());
    expect(plans.confirm({ ...write(), agentId: 'child' })?.planId).not.toBe(base?.planId);
    expect(plans.confirm({ ...write(), scopeId: 'next' })?.planId).not.toBe(base?.planId);
  });
});

describe('confirmed references to registered Markdown plans', () => {
  const shell = (command = 'python3 -c \'p="PLANO-CANVAS.md"; print(p)\'') => ({
    ...context,
    scopeId: 'next-assignment',
    toolName: 'Bash',
    input: { command },
    output: { stdout: '', stderr: '', interrupted: false },
  });

  it.each(['"PLANO-CANVAS.md"', "'/tmp/project/PLANO-CANVAS.md'"])(
    'reattaches only the registered file to a new scope without guessing its progress (%s)',
    (path) => {
      const plans = new ConfirmedClaudePlans();
      const previous = plans.confirm(write());
      const candidate = plans.confirm(shell(`cat ${path}`));
      expect(candidate).toMatchObject({
        sourceTool: 'Markdown',
        sourceFile: 'PLANO-CANVAS.md',
        scopeId: 'next-assignment',
        completeness: 'partial',
        steps: [],
      });
      expect(candidate?.planId).not.toBe(previous?.planId);
      expect(
        workProgress(candidate && { ...candidate, updatedAt: '2026-10-14T18:00:00Z' }).percent,
      ).toBeUndefined();
      expect(plans.confirm(shell(`cat ${path}`))).toBeUndefined();
    },
  );

  it.each([
    { output: undefined },
    { output: { success: false } },
    { output: { interrupted: true } },
    { output: { is_error: true } },
    { output: { exitCode: 1 } },
    { output: { exit_code: 1 } },
    { output: { status: 'failed' } },
    { output: { error: 'failed' } },
    { input: { command: 'cat "another-plan.md"' } },
    { input: { command: 'cat PLANO-CANVAS.md' } },
    { input: { command: 'cat "subdir/PLANO-CANVAS.md"' } },
    { input: { command: 'cat "/tmp/other/PLANO-CANVAS.md"' } },
    { projectPath: '/tmp/project/subdir' },
    { projectPath: undefined },
    { agentId: 'other-agent' },
    { sessionId: 'other-session' },
    { scopeId: 'assignment' },
    { scopeId: undefined },
  ])('rejects unconfirmed, failed, unrelated or unscoped references (%#)', (change) => {
    const plans = new ConfirmedClaudePlans();
    plans.confirm(write());
    expect(plans.confirm({ ...shell(), ...change })).toBeUndefined();
  });

  it('does not discover plans from shell text or failed writes', () => {
    const plans = new ConfirmedClaudePlans();
    expect(plans.confirm(shell())).toBeUndefined();
    plans.confirm({ ...write(), output: { ...write().output, success: false } });
    expect(plans.confirm(shell())).toBeUndefined();
  });

  it('rejects ambiguous references to more than one registered plan', () => {
    const plans = new ConfirmedClaudePlans();
    plans.confirm(write());
    plans.confirm(write(document, '/tmp/project/other-plan.md'));
    expect(plans.confirm(shell('cat "PLANO-CANVAS.md" "other-plan.md"'))).toBeUndefined();
  });
});

describe('Markdown checklist boundaries', () => {
  it('ignores fenced examples and accepts Portuguese and English plan headings', () => {
    expect(
      parseMarkdownPlan('# Implementation plan\n```md\n- [x] Example\n```\n- [ ] Work')?.map(
        (step) => step.text,
      ),
    ).toEqual(['Work']);
    expect(
      parseMarkdownPlan('# Acompanhamento\n~~~\n- [x] Example\n~~~\n1. [X] Work')?.[0]?.status,
    ).toBe('completed');
  });

  it.each([
    '# Notes\n- [x] A\n- [ ] B',
    '# Plan\nOnly prose and 50%',
    '# Plan\n- [x] Parent\n  - [ ] Nested child',
    '# Plan\n- [~] Running\n- [ ] Pending',
    '# Plan\n- [ ] ',
    '# Plan\n- [x] Work\n```md\nUnclosed example',
    `# Plan\n- [ ] ${'a'.repeat(4001)}`,
    `# Plan\n${'- [x] Work\n'.repeat(501)}`,
    `# Plan\n- [x] Work\n${'a'.repeat(MARKDOWN_PLAN_MAX_BYTES)}`,
  ])('rejects missing, ambiguous, malformed, or oversized complete snapshots (%#)', (content) => {
    expect(parseMarkdownPlan(content)).toBeUndefined();
  });

  it.each([
    'README.md',
    'plan.ts',
    '../plan.md',
    '/tmp/other/plan.md',
    '/tmp/project-neighbor/plan.md',
  ])('does not follow arbitrary or outside paths (%s)', (path) => {
    expect(markdownPlanSourceFile('/tmp/project', path)).toBeUndefined();
  });

  it('normalizes only explicit files within the recorded project directory', () => {
    expect(markdownPlanSourceFile('/tmp/project', 'docs/../PLANO.md')).toBe('PLANO.md');
    expect(markdownPlanSourceFile('/tmp/project', '/tmp/project/docs/implementation-plan.md')).toBe(
      'docs/implementation-plan.md',
    );
  });
});
