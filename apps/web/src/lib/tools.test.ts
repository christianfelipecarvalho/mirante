import { describe, expect, it } from 'vitest';
import { describeTool, isPlumbing, toolCategory } from './tools.js';

describe('recognising what a tool call is', () => {
  it('groups tools by the kind of work they do', () => {
    expect(toolCategory('Bash')).toBe('shell');
    expect(toolCategory('Read')).toBe('read');
    expect(toolCategory('Edit')).toBe('write');
    expect(toolCategory('Grep')).toBe('search');
    expect(toolCategory('Agent')).toBe('agent');
  });

  it('does not pretend to know an unfamiliar tool', () => {
    expect(toolCategory('mcp__something__do_thing')).toBe('other');
    expect(toolCategory('WhateverNew')).toBe('other');
  });

  it('marks plumbing so it can recede without being hidden', () => {
    expect(isPlumbing('ReadNotifications')).toBe(true);
    expect(isPlumbing('SubagentHandback')).toBe(true);
    expect(isPlumbing('Bash')).toBe(false);
  });
});

describe('splitting a tool argument', () => {
  it('puts the filename first and the directory behind it', () => {
    // The same split an editor makes in a tab, for the same reason: the folder
    // is rarely the thing you are looking for.
    const described = describeTool('Read', '/home/user/project/src/app/layout.tsx');
    expect(described.primary).toBe('layout.tsx');
    expect(described.secondary).toBe('/home/user/project/src/app');
  });

  it('keeps a command on its first line', () => {
    const described = describeTool('Bash', "python3 - <<'PY'\nimport io\nprint(1)");
    expect(described.primary).toBe("python3 - <<'PY'");
    expect(described.secondary).toContain('import io');
  });

  it('uses a monospace face for commands and paths, not for prose', () => {
    expect(describeTool('Bash', 'pnpm build').mono).toBe(true);
    expect(describeTool('Read', '/tmp/a.txt').mono).toBe(true);
    expect(describeTool('Agent', 'Review the export path').mono).toBe(false);
  });

  it('survives an empty argument', () => {
    expect(describeTool('Bash', undefined)).toEqual({
      category: 'shell',
      primary: '',
      mono: false,
    });
  });
});
