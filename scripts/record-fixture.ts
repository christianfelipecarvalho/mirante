#!/usr/bin/env node
/**
 * Records a real Claude Code session into tests/fixtures/, redacted.
 *
 * Mirante parses data it does not own. Writing parsers against a remembered
 * schema is how you ship a reader that works on the session you imagined; this
 * script exists so every parser is written against a session that actually
 * happened. See CLAUDE.md.
 *
 * Usage:
 *   pnpm fixture:record -- --session <sessionId> --name <fixture-name> [--from 0] [--max-entries 400]
 *   pnpm fixture:record -- --list
 *
 * `--from` matters more than it looks: the interesting part of a session — the
 * moment it fans out into subagents — is usually hundreds of entries in, so a
 * prefix slice records the boring half.
 *
 * Redaction keeps structure and discards content: field names, ids, timestamps,
 * tool names, and token counts survive; prompt text, tool inputs, results, file
 * paths, and branch names do not. Review the output by hand anyway — this script
 * is a safety net, not a guarantee.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures');
const HOME = homedir();
const USERNAME = basename(HOME);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Patterns that must never reach a committed fixture, even inside a "structural" field. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
];

const scrubSecrets = (value: string): string =>
  SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[REDACTED-SECRET]'), value);

/**
 * Absolute paths carry the things a fixture most easily leaks: the machine
 * username, employer and client names in directory names, private repository
 * names. Replacing only the home prefix leaves all of that intact, so every
 * known project path is aliased whole and the remaining segments are treated as
 * forbidden words during verification.
 */
type Alias = { from: string; to: string };

let pathAliases: Alias[] = [];
let wordAliases: Alias[] = [];

/**
 * Words that must not survive redaction, derived from the real paths rather than
 * hand-listed — the leak that matters is always the one nobody thought to add to
 * a list. A directory named after an employer, a client, or a private repository
 * is exactly as identifying as a token.
 */
const forbiddenWords = (cwds: string[]): string[] => {
  const words = new Set<string>([USERNAME]);
  for (const cwd of cwds) {
    for (const segment of cwd.split('/')) {
      if (segment.length > 2 && segment !== 'home' && segment !== 'tmp') words.add(segment);
    }
  }
  return [...words];
};

const setPathAliases = (cwds: string[]): void => {
  const uniqueCwds = [...new Set(cwds)].sort((a, b) => b.length - a.length);
  pathAliases = uniqueCwds.map((cwd, index) => ({
    from: cwd,
    to: index === 0 ? '/home/user/project' : `/home/user/project-${index + 1}`,
  }));

  // Longest first, so `prospect-web` is aliased before `prospect` can eat its prefix.
  const words = forbiddenWords(cwds)
    .filter((w) => w !== USERNAME)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  wordAliases = [
    { from: USERNAME, to: 'user' },
    ...words.map((word, index) => ({ from: word, to: `dir${index + 1}` })),
  ];
};

/**
 * Aliases whole paths first, then any surviving identifying segment. A bare
 * `prospect-web/src/App.tsx` in a tool input is not a full cwd and would slip
 * through path aliasing alone.
 */
const scrubPaths = (value: string): string => {
  let out = scrubSecrets(value).split(HOME).join('/home/user');
  for (const { from, to } of pathAliases) out = out.split(from).join(to);
  for (const { from, to } of wordAliases) out = out.split(from).join(to);
  return out.replace(/\/tmp\/claude-\d+\//g, '/tmp/claude/');
};

const placeholder = (label: string, original: string): string =>
  `[redacted ${label}: ${original.length} chars]`;

/** Keys whose string values are structural and safe to keep verbatim after path scrubbing. */
const STRUCTURAL_KEYS = new Set([
  'type',
  'role',
  'model',
  'name',
  'id',
  'uuid',
  'parentUuid',
  'sessionId',
  'agentId',
  'promptId',
  'requestId',
  'timestamp',
  'version',
  'userType',
  'entrypoint',
  'stop_reason',
  'service_tier',
  'permissionMode',
  'origin',
  'promptSource',
  'status',
  'agentType',
  'attributionSkill',
  'attributionAgent',
  'toolUseId',
  'tool_use_id',
  'sourceToolUseID',
  'sourceToolAssistantUUID',
  'resumedAgentId',
  'resolvedModel',
  'taskType',
  'workflowName',
  'runId',
  'speed',
  'inference_geo',
]);

/** Free-text keys: length is informative, content is not worth the risk. */
const TEXT_KEYS = new Set([
  'text',
  'thinking',
  'content',
  'prompt',
  'description',
  'summary',
  'message',
  'signature',
  'stdout',
  'stderr',
]);

const redact = (value: Json, key?: string): Json => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;

  if (typeof value === 'string') {
    if (key === 'gitBranch') return 'feature/example';
    if (key === 'cwd' || key === 'outputFile' || key === 'transcriptDir') return scrubPaths(value);
    if (key && STRUCTURAL_KEYS.has(key)) return scrubPaths(value);
    if (key && TEXT_KEYS.has(key)) return placeholder(key, value);
    // Unknown key: keep only short values, and scrub them.
    return value.length <= 40 ? scrubPaths(value) : placeholder('value', value);
  }

  if (Array.isArray(value)) return value.map((item) => redact(item, key));

  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
};

const parseArgs = (argv: string[]): Record<string, string | boolean> => {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[name] = next;
      i += 1;
    } else {
      out[name] = true;
    }
  }
  return out;
};

type SessionLocation = { slug: string; sessionId: string; mainPath: string; subagentsDir: string };

const findSessions = (): SessionLocation[] => {
  if (!existsSync(PROJECTS_DIR)) return [];
  const found: SessionLocation[] = [];
  for (const slug of readdirSync(PROJECTS_DIR)) {
    const dir = join(PROJECTS_DIR, slug);
    if (!statSync(dir).isDirectory()) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.jsonl')) continue;
      const sessionId = basename(entry, '.jsonl');
      found.push({
        slug,
        sessionId,
        mainPath: join(dir, entry),
        subagentsDir: join(dir, sessionId, 'subagents'),
      });
    }
  }
  return found;
};

const readJsonl = (path: string): Json[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Json);

const main = (): void => {
  const args = parseArgs(process.argv.slice(2));
  const sessions = findSessions();

  if (args.list) {
    for (const s of sessions) {
      const hasSubagents = existsSync(s.subagentsDir);
      const size = statSync(s.mainPath).size;
      console.log(
        `${s.sessionId}  ${(size / 1024).toFixed(0).padStart(7)} KB  ${hasSubagents ? 'subagents' : '         '}  ${s.slug}`,
      );
    }
    return;
  }

  const sessionId = typeof args.session === 'string' ? args.session : undefined;
  const name = typeof args.name === 'string' ? args.name : undefined;
  const maxEntries = typeof args['max-entries'] === 'string' ? Number(args['max-entries']) : 400;
  const from = typeof args.from === 'string' ? Number(args.from) : 0;
  const subagentEntries =
    typeof args['subagent-entries'] === 'string' ? Number(args['subagent-entries']) : 60;

  if (!sessionId || !name) {
    console.error('Usage: pnpm fixture:record -- --session <sessionId> --name <fixture-name>');
    console.error('       pnpm fixture:record -- --list');
    process.exitCode = 1;
    return;
  }

  const session = sessions.find((s) => s.sessionId === sessionId);
  if (!session) {
    console.error(`Session ${sessionId} not found under ${PROJECTS_DIR}`);
    process.exitCode = 1;
    return;
  }

  const mainEntries = readJsonl(session.mainPath);

  const cwds = mainEntries
    .map((e) => (typeof e === 'object' && e !== null && !Array.isArray(e) ? e.cwd : undefined))
    .filter((c): c is string => typeof c === 'string');
  setPathAliases(cwds);
  const forbidden = forbiddenWords(cwds);

  const outDir = join(FIXTURES_DIR, name);
  mkdirSync(join(outDir, 'subagents'), { recursive: true });

  const keptMain = mainEntries.slice(from, from + maxEntries).map((e) => redact(e));
  const written: { path: string; content: string }[] = [
    {
      path: join(outDir, 'main.jsonl'),
      content: keptMain.map((e) => JSON.stringify(e)).join('\n') + '\n',
    },
  ];

  const subagentFiles: string[] = [];
  if (existsSync(session.subagentsDir)) {
    for (const file of readdirSync(session.subagentsDir)) {
      const full = join(session.subagentsDir, file);
      if (!statSync(full).isFile()) continue;

      if (file.endsWith('.meta.json')) {
        const meta = redact(JSON.parse(readFileSync(full, 'utf8')) as Json);
        written.push({
          path: join(outDir, 'subagents', file),
          content: JSON.stringify(meta, null, 2) + '\n',
        });
        subagentFiles.push(file);
      } else if (file.endsWith('.jsonl')) {
        const entries = readJsonl(full)
          .slice(0, subagentEntries)
          .map((e) => redact(e));
        written.push({
          path: join(outDir, 'subagents', file),
          content: entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
        });
        subagentFiles.push(file);
      }
    }
  }

  // Refuse to write a fixture that still carries anything traceable. The recorder
  // is the last point at which a leak is cheap to stop; after `git push` it is not.
  const leaks: string[] = [];
  for (const file of written) {
    for (const word of forbidden) {
      if (file.content.includes(word)) leaks.push(`${basename(file.path)}: "${word}"`);
    }
  }
  if (leaks.length > 0) {
    console.error('Refusing to write: redacted output still contains identifying strings.\n');
    for (const leak of [...new Set(leaks)].slice(0, 20)) console.error(`  ${leak}`);
    console.error('\nFix the redaction in scripts/record-fixture.ts, then re-record.');
    process.exitCode = 1;
    return;
  }

  for (const file of written) writeFileSync(file.path, file.content);

  const manifest = {
    name,
    recordedAt: new Date().toISOString(),
    claudeVersion:
      (
        keptMain.find((e) => typeof e === 'object' && e !== null && 'version' in e) as
          { version?: string } | undefined
      )?.version ?? 'unknown',
    mainEntries: keptMain.length,
    mainEntriesSlice: { from, to: from + keptMain.length, of: mainEntries.length },
    subagentEntriesPerFile: subagentEntries,
    subagentFiles: subagentFiles.sort(),
    /** Ties the fixture to the exact recorder that produced it, so redaction changes are auditable. */
    recorderHash: createHash('sha256')
      .update(readFileSync(new URL(import.meta.url), 'utf8'))
      .digest('hex')
      .slice(0, 12),
    redaction:
      'Structure, ids, timestamps, tool names and token counts kept. Prompt text, tool inputs, ' +
      'results, absolute paths and branch names replaced. Review by hand before committing.',
  };
  writeFileSync(join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(`Wrote ${outDir}`);
  console.log(
    `  main.jsonl            ${manifest.mainEntries} entries (${from}..${from + keptMain.length} of ${mainEntries.length})`,
  );
  console.log(`  subagents/            ${subagentFiles.length} files`);
  console.log(
    `\nVerified against ${forbidden.length} identifying strings. Review before committing.`,
  );
};

main();
