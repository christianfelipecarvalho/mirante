import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * A subagent definition, as declared in `.claude/agents/*.md`.
 *
 * Read so the board can show an agent by the name and colour its author gave
 * it, rather than by a deterministic glyph Mirante invented. A definition is
 * the closest thing to an agent's identity that exists on disk.
 */
export type AgentDefinition = {
  name: string;
  description?: string;
  /** One of Claude Code's named colours: red, blue, green, yellow, purple, orange, pink, cyan. */
  color?: string;
  model?: string;
  /** Where it came from, since a project definition shadows a user one. */
  scope: 'project' | 'user';
};

/**
 * Frontmatter, read by hand.
 *
 * Only scalar `key: value` lines matter here, and a YAML parser is a dependency
 * plus an attack surface for a file Mirante does not own. Anything it cannot
 * read is skipped rather than throwing: a malformed agent file must not take
 * the board down.
 */
const parseFrontmatter = (source: string): Record<string, string> => {
  if (!source.startsWith('---')) return {};
  const end = source.indexOf('\n---', 3);
  if (end === -1) return {};

  const lines = source.slice(3, end).split('\n');
  const fields: Record<string, string> = {};

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[index] ?? '');
    if (!match?.[1]) continue;
    const key = match[1];
    const inline = (match[2] ?? '').trim();

    // `description: >` and `description: |` are YAML block scalars: the value is
    // the indented lines that follow, not the indicator. Read literally, every
    // agent written that way describes itself as ">".
    if (inline === '>' || inline === '|' || inline === '>-' || inline === '|-') {
      const block: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1] ?? '';
        if (next.trim().length > 0 && !/^\s/.test(next)) break;
        block.push(next.trim());
        index += 1;
      }
      const joined = block.join(inline.startsWith('>') ? ' ' : '\n').trim();
      if (joined.length > 0) fields[key] = joined;
      continue;
    }

    const value = inline.replace(/^["']|["']$/g, '');
    if (value.length > 0) fields[key] = value;
  }
  return fields;
};

const readDirectory = (directory: string, scope: AgentDefinition['scope']): AgentDefinition[] => {
  if (!existsSync(directory)) return [];
  const definitions: AgentDefinition[] = [];

  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    let source: string;
    try {
      source = readFileSync(join(directory, entry), 'utf8');
    } catch {
      continue;
    }
    const fields = parseFrontmatter(source);
    const name = fields.name ?? basename(entry, '.md');
    definitions.push({
      name,
      ...(fields.description ? { description: fields.description } : {}),
      ...(fields.color ? { color: fields.color } : {}),
      ...(fields.model ? { model: fields.model } : {}),
      scope,
    });
  }
  return definitions;
};

/**
 * Every agent visible to a project, project definitions winning over user ones —
 * the same precedence Claude Code applies when it resolves a subagent by name.
 */
export const loadAgentDefinitions = (
  projectPaths: readonly string[],
  home = homedir(),
): AgentDefinition[] => {
  const byName = new Map<string, AgentDefinition>();

  for (const definition of readDirectory(join(home, '.claude', 'agents'), 'user')) {
    byName.set(definition.name, definition);
  }
  for (const projectPath of projectPaths) {
    if (!projectPath) continue;
    for (const definition of readDirectory(join(projectPath, '.claude', 'agents'), 'project')) {
      byName.set(definition.name, definition);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
};
