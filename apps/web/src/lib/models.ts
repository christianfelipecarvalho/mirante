/**
 * The model an agent runs, as a person reads it.
 *
 * `claude-haiku-4-5-20251001` is exact and takes a moment to parse; a card read
 * at a glance wants "Haiku 4.5". The id as reported stays beside the label for a
 * tooltip, because the part the label drops is occasionally what someone needs.
 */
export type ModelLabel = {
  /** What the card shows: "Opus 5.5", "Sonnet 5", "GPT-6 Sol". */
  short: string;
  /** The id as reported, for a tooltip. */
  full: string;
  /** Read from the id itself, never from the adapter that reported it. */
  vendor?: 'anthropic' | 'openai';
};

/**
 * Values that sit where a model id goes but name no model. `<synthetic>` marks a
 * message Claude Code produced locally, and `inherit` means "whatever the parent
 * runs" — true, but it says nothing on a card of its own. Both read as unknown.
 */
const NOT_A_MODEL = new Set(['inherit', '<synthetic>']);

/** What subagent definitions write in place of a full id. */
const ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable']);

/**
 * `claude-opus-5-5`, `claude-haiku-4-5-20251001`. The minor version stops at two
 * digits so that a snapshot date is never read as one: `claude-opus-4-20250514`
 * is Opus 4, not Opus 4.20250514.
 */
const CLAUDE = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;

/** The order Claude ids used before version 4: `claude-3-5-sonnet-20241022`. */
const CLAUDE_LEGACY = /^claude-(\d+)-(\d{1,2})-([a-z]+)(?:-\d{8})?$/;

/**
 * The 1M-context variant. Same model, larger window — two cards that differ
 * only by this must not read the same.
 */
const ONE_MILLION = '[1m]';

/**
 * `gpt-6-sol`, `gpt-5.3-codex-spark`. Only words after the version, so an id
 * carrying a date or anything else unseen passes through as it came.
 */
const GPT = /^gpt-(\d+(?:\.\d+)*)((?:-[a-z]+)*)$/;

/** `o3`, `o4-mini`: already as short as a label gets. */
const O_SERIES = /^o\d+(?:-[a-z]+)*$/;

const capitalise = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

const named = (family: string, major: string, minor: string | undefined): string =>
  `${capitalise(family)} ${minor === undefined ? major : `${major}.${minor}`}`;

const claudeName = (id: string): string | undefined => {
  if (ALIASES.has(id)) return capitalise(id);
  const [, family, major, minor] = CLAUDE.exec(id) ?? [];
  if (family && major) return named(family, major, minor);
  const [, legacyMajor, legacyMinor, legacyFamily] = CLAUDE_LEGACY.exec(id) ?? [];
  if (legacyFamily && legacyMajor) return named(legacyFamily, legacyMajor, legacyMinor);
  return undefined;
};

const openaiName = (id: string): string | undefined => {
  if (O_SERIES.test(id)) return id;
  const [, version, rest = ''] = GPT.exec(id) ?? [];
  if (version === undefined) return undefined;
  const words = rest.split('-').filter(Boolean).map(capitalise);
  return [`GPT-${version}`, ...words].join(' ');
};

/**
 * Turns a reported model id into what a card shows, or `undefined` when there is
 * no model to show — the caller says "unknown", never a blank.
 *
 * An id this does not recognise passes through as it came. A prettier name
 * guessed for an id nobody here has seen would be a claim the board cannot back.
 */
export const modelLabel = (raw: string | undefined): ModelLabel | undefined => {
  if (raw === undefined || raw.trim() === '' || NOT_A_MODEL.has(raw)) return undefined;

  const wide = raw.endsWith(ONE_MILLION);
  const claude = claudeName(wide ? raw.slice(0, -ONE_MILLION.length) : raw);
  if (claude) return { short: wide ? `${claude} 1M` : claude, full: raw, vendor: 'anthropic' };

  const openai = openaiName(raw);
  if (openai) return { short: openai, full: raw, vendor: 'openai' };

  return { short: raw, full: raw };
};
