/**
 * Redaction runs at ingest, before anything reaches SQLite.
 *
 * Doing it at read time would leave the secret on disk, where a later purge, a
 * backup, or a bug report can still surface it. See ADR-0005.
 */

/** Patterns worth catching by shape alone, before any truncation. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /(?<=(?:password|passwd|secret|token|api[_-]?key)["'\s:=]{1,4})[^\s"',}]{8,}/gi,
];

export const REDACTED = '[redacted]';

export const scrubSecrets = (value: string): string =>
  SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, REDACTED), value);

/**
 * A card shows one line. Anything longer is weight without information, and the
 * longer the stored string, the more chances it carries something it should not.
 */
export const DEFAULT_PREVIEW_LENGTH = 160;

/**
 * What an agent writes is meant to be read, not glanced at, so it keeps more
 * than a tool summary does — about a short paragraph. Still bounded: the log is
 * append-only, and a stored string is a stored risk however local it is.
 */
export const SAID_PREVIEW_LENGTH = 400;

/**
 * The instruction one agent writes for another: the longest text on the board
 * worth keeping, and the only one whose internal structure carries meaning.
 *
 * Measured against real sessions, briefs run from 3,000 to 5,000 characters. A
 * screenful is kept here; the rest is not lost quietly — the count of what was
 * written travels with it, so a card can say how much it is not showing.
 */
export const BRIEF_PREVIEW_LENGTH = 700;

/**
 * A preview of written text, with its paragraphs intact.
 *
 * `preview` flattens everything to one line, which is right for a command and
 * wrong for an instruction: a numbered list arrives as a run-on sentence. This
 * keeps one blank line between paragraphs and the leading marker of a list
 * item, and collapses everything else. Scrubbing is identical.
 */
export const previewProse = (value: unknown, max = BRIEF_PREVIEW_LENGTH): string => {
  if (typeof value !== 'string') return '';
  const scrubbed = scrubSecrets(value)
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
  return scrubbed.length <= max ? scrubbed : `${scrubbed.slice(0, max - 1)}…`;
};

export const preview = (value: unknown, max = DEFAULT_PREVIEW_LENGTH): string => {
  if (typeof value !== 'string') return '';
  const scrubbed = scrubSecrets(value).replace(/\s+/g, ' ').trim();
  return scrubbed.length <= max ? scrubbed : `${scrubbed.slice(0, max - 1)}…`;
};

/**
 * One line describing a tool call, for the card's "current activity" row.
 *
 * Picks the field that actually tells you what is happening — the command for
 * Bash, the path for a file tool — because "Bash" alone answers nothing a person
 * watching a board wants to know.
 */
export const summarizeToolInput = (toolName: string, input: unknown): string => {
  if (typeof input !== 'object' || input === null) return '';
  const fields = input as Record<string, unknown>;

  const preferred: Record<string, readonly string[]> = {
    Bash: ['command', 'description'],
    Read: ['file_path'],
    Write: ['file_path'],
    Edit: ['file_path'],
    Glob: ['pattern'],
    Grep: ['pattern'],
    Agent: ['description', 'subagent_type'],
    Skill: ['skill', 'args'],
    WebFetch: ['url'],
    Task: ['description'],
  };

  const order = preferred[toolName] ?? ['description', 'command', 'file_path', 'pattern', 'query'];
  for (const key of order) {
    const candidate = fields[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) return preview(candidate);
  }
  return '';
};
