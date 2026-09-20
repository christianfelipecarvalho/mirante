/**
 * What a tool call actually is, for someone scanning a list of them.
 *
 * A stream that says "Bash" four hundred times is accurate and unreadable. The
 * category gives each line a shape you can recognise without reading it, and the
 * split between a primary and a secondary part lets the thing that identifies
 * the call — a filename, the head of a command — win the eye over the path it
 * happens to live in.
 */
export type ToolCategory =
  'shell' | 'read' | 'write' | 'search' | 'web' | 'agent' | 'skill' | 'wait' | 'other';

export const CATEGORY_GLYPH: Record<ToolCategory, string> = {
  shell: '❯',
  read: '▤',
  write: '✎',
  search: '⌕',
  web: '⊕',
  agent: '⇢',
  skill: '✦',
  wait: '◔',
  other: '▸',
};

const BY_TOOL: Record<string, ToolCategory> = {
  Bash: 'shell',
  BashOutput: 'shell',
  KillShell: 'shell',
  Read: 'read',
  NotebookRead: 'read',
  Write: 'write',
  Edit: 'write',
  MultiEdit: 'write',
  NotebookEdit: 'write',
  Glob: 'search',
  Grep: 'search',
  ToolSearch: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  Agent: 'agent',
  Task: 'agent',
  SubagentHandback: 'agent',
  TaskStop: 'agent',
  SendMessage: 'agent',
  Workflow: 'agent',
  Skill: 'skill',
  Monitor: 'wait',
  ReadNotifications: 'wait',
  AskUserQuestion: 'wait',
};

export const toolCategory = (toolName: string): ToolCategory => {
  if (BY_TOOL[toolName]) return BY_TOOL[toolName] as ToolCategory;
  if (toolName.startsWith('mcp__')) return 'other';
  return 'other';
};

/**
 * Tools whose value is plumbing rather than progress.
 *
 * Kept in the stream — leaving them out would make the record dishonest — but
 * recessive, so they do not compete with the work.
 */
export const isPlumbing = (toolName: string): boolean =>
  toolCategory(toolName) === 'wait' || toolName === 'SubagentHandback' || toolName === 'TaskStop';

const looksLikePath = (value: string): boolean =>
  /^[~/.]|^[A-Za-z]:\\/.test(value) && !value.includes('\n') && value.length < 260;

export type ToolDescription = {
  category: ToolCategory;
  /** The part that identifies the call: a filename, the head of a command. */
  primary: string;
  /** Context for it: the directory, the rest of the command. */
  secondary?: string;
  /** True when the primary should be shown in a monospace face. */
  mono: boolean;
};

/**
 * Splits a tool's argument into what identifies it and what merely locates it.
 *
 * For a file, that is the filename against its directory — the same split an
 * editor makes in a tab, and for the same reason: the folder is rarely what you
 * are looking for.
 */
export const describeTool = (toolName: string, detail: string | undefined): ToolDescription => {
  const category = toolCategory(toolName);
  const value = (detail ?? '').trim();

  if (value.length === 0) return { category, primary: '', mono: false };

  if (looksLikePath(value)) {
    const parts = value.split('/');
    const name = parts.pop() ?? value;
    const directory = parts.join('/');
    return {
      category,
      primary: name,
      ...(directory ? { secondary: directory } : {}),
      mono: true,
    };
  }

  // A command: keep the first line, and let the rest be context.
  const [first = '', ...rest] = value.split('\n');
  const overflow = rest.join(' ').trim();
  return {
    category,
    primary: first,
    ...(overflow ? { secondary: overflow } : {}),
    mono: category === 'shell' || category === 'search',
  };
};
