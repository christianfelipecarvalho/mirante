import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgentDefinitions } from './agents.js';

const roots: string[] = [];
const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'mirante-agents-'));
  roots.push(root);
  return root;
};
const writeAgent = (dir: string, file: string, body: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), body);
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('reading agent definitions', () => {
  it('takes the name, description and colour their author gave them', () => {
    const home = workspace();
    writeAgent(
      join(home, '.claude', 'agents'),
      'reviewer.md',
      '---\nname: code-reviewer\ndescription: Reviews code for quality\ncolor: purple\nmodel: sonnet\n---\n\nYou review code.\n',
    );
    const [definition] = loadAgentDefinitions([], home);
    expect(definition).toEqual({
      name: 'code-reviewer',
      description: 'Reviews code for quality',
      color: 'purple',
      model: 'sonnet',
      scope: 'user',
    });
  });

  it('lets a project definition shadow a user one, as Claude Code does', () => {
    const home = workspace();
    const project = workspace();
    writeAgent(join(home, '.claude', 'agents'), 'a.md', '---\nname: helper\ncolor: blue\n---\n');
    writeAgent(join(project, '.claude', 'agents'), 'a.md', '---\nname: helper\ncolor: red\n---\n');
    const [definition] = loadAgentDefinitions([project], home);
    expect(definition).toMatchObject({ color: 'red', scope: 'project' });
  });

  it('falls back to the filename when the frontmatter omits a name', () => {
    const home = workspace();
    writeAgent(join(home, '.claude', 'agents'), 'silent.md', 'no frontmatter here\n');
    expect(loadAgentDefinitions([], home)[0]?.name).toBe('silent');
  });

  it('skips a malformed file rather than failing the whole read', () => {
    // A board that goes blank because someone left a stray file in .claude/agents
    // would be worse than one missing an icon.
    const home = workspace();
    writeAgent(join(home, '.claude', 'agents'), 'broken.md', '---\nname: broken\n');
    writeAgent(join(home, '.claude', 'agents'), 'fine.md', '---\nname: fine\ncolor: green\n---\n');
    const names = loadAgentDefinitions([], home).map((d) => d.name);
    expect(names).toContain('fine');
    expect(names).toContain('broken');
  });

  it('reads a folded description instead of the block indicator', () => {
    // `description: >` is a YAML block scalar. Read literally, every agent
    // written that way describes itself as ">".
    const home = workspace();
    writeAgent(
      join(home, '.claude', 'agents'),
      'folded.md',
      '---\nname: architect\ndescription: >\n  Designs the system before\n  any code is written\nmodel: opus\n---\n',
    );
    const [definition] = loadAgentDefinitions([], home);
    expect(definition?.description).toBe('Designs the system before any code is written');
    expect(definition?.model).toBe('opus');
  });

  it('keeps line breaks in a literal block', () => {
    const home = workspace();
    writeAgent(
      join(home, '.claude', 'agents'),
      'literal.md',
      '---\nname: dba\ndescription: |\n  first line\n  second line\n---\n',
    );
    expect(loadAgentDefinitions([], home)[0]?.description).toBe('first line\nsecond line');
  });

  it('returns nothing when there are no agents, without throwing', () => {
    expect(loadAgentDefinitions([], workspace())).toEqual([]);
  });
});
