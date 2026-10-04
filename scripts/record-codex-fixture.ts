#!/usr/bin/env node
/**
 * Records a real OpenAI Codex session — its root thread and its subagent
 * threads — into tests/fixtures/, redacted.
 *
 * The Codex reader parses files Mirante does not own, written by a tool whose
 * format changes between minor versions (0.154 and 0.155 report the same
 * prompt in different records). This script exists so that reader is written
 * against sessions that actually happened. See CLAUDE.md.
 *
 * Usage:
 *   pnpm fixture:codex -- --list
 *   pnpm fixture:codex -- --session <rootSessionId> --name <fixture-name> [--max-lines 400]
 *
 * It opens only rollout files under the sessions directory. It never opens
 * `auth.json` or anything else beside them.
 *
 * Redaction keeps structure and discards content: record types, ids, turn ids,
 * call ids, timestamps, tool names, agent roles and token counts survive;
 * prompts, messages, command text, outputs, file paths, task names and skill
 * names do not. A command keeps its shape — `cmd:"…"`, a path ending in
 * `/skills/<name>/SKILL.md` — with every word inside replaced, because those
 * shapes are what the reader keys on. Review the output by hand anyway.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const SESSIONS_DIR = join(CODEX_HOME, 'sessions');
const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures');
const HOME = homedir();
const USERNAME = basename(HOME);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

const isObj = (value: Json | undefined): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
];

const scrubSecrets = (value: string): string =>
  SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[REDACTED-SECRET]'), value);

const placeholder = (label: string, original: string): string =>
  `[redacted ${label}: ${original.length} chars]`;

/** Aliases handed out in order of first sight, so the same name maps the same way everywhere. */
const aliasTable = (prefix: string) => {
  const seen = new Map<string, string>();
  return (value: string): string => {
    const existing = seen.get(value);
    if (existing) return existing;
    const alias = `${prefix}-${seen.size + 1}`;
    seen.set(value, alias);
    return alias;
  };
};

const taskAlias = aliasTable('task');
const skillAlias = aliasTable('skill');
const roleAlias = aliasTable('role');

/**
 * Roles Codex ships with, or that name a discipline rather than a person's
 * project. Anything else is a custom agent the user defined and named, often
 * after the product it works on, and is aliased.
 */
const GENERIC_ROLES = new Set([
  'default',
  'worker',
  'explorer',
  'architect',
  'dba',
  'qa',
  'reviewer',
  'planner',
  'designer',
]);
const role = (value: string): string => (GENERIC_ROLES.has(value) ? value : roleAlias(value));

/** Identifying words, derived from the real paths rather than hand-listed. */
let forbidden: string[] = [];
let cwdAliases: { from: string; to: string }[] = [];

const setCwds = (cwds: string[]): void => {
  const unique = [...new Set(cwds)].sort((a, b) => b.length - a.length);
  cwdAliases = unique.map((cwd, index) => ({
    from: cwd,
    to: index === 0 ? '/home/user/project' : `/home/user/project-${index + 1}`,
  }));
  const words = new Set<string>([USERNAME]);
  for (const cwd of unique) {
    for (const segment of cwd.split('/')) {
      if (segment.length > 2 && segment !== 'home' && segment !== 'tmp') words.add(segment);
    }
  }
  forbidden = [...words];
};

const scrubPath = (value: string): string => {
  let out = scrubSecrets(value);
  for (const { from, to } of cwdAliases) out = out.split(from).join(to);
  return out.split(HOME).join('/home/user');
};

/**
 * A command, rebuilt with nothing of the original but its shape.
 *
 * Every `cmd:"…"` keeps its quotes and loses its words; every skill read keeps
 * the `/skills/<alias>/SKILL.md` tail the reader recognises, so a fixture can
 * prove the reader finds a skill without naming the person's skills.
 */
const redactCommand = (input: string): string => {
  const skills = [...input.matchAll(/skills\/([\w.-]+)\/SKILL\.md/g)].map(
    (match) => `sed -n '1,200p' .agents/skills/${skillAlias(match[1] ?? '')}/SKILL.md`,
  );
  const cmds = [...input.matchAll(/\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((match) =>
    (match[1] ?? '').replace(/SKILL\.md/g, '').length > 0
      ? `cmd:"${placeholder('command', match[1] ?? '')}"`
      : '',
  );
  const tools = [...new Set([...input.matchAll(/tools\.(\w+)\(/g)].map((m) => m[1] ?? ''))].filter(
    (tool) => tool !== 'exec_command',
  );
  const lines = [
    ...tools.map((tool) => `await tools.${tool}({})`),
    ...cmds.filter(Boolean).map((cmd) => `await tools.exec_command({${cmd}})`),
    ...skills.map((cmd) => `await tools.exec_command({cmd:"${cmd}"})`),
  ];
  return lines.length > 0 ? lines.join('\n') : placeholder('input', input);
};

const redactArguments = (name: string, raw: string): string => {
  let args: Json;
  try {
    args = JSON.parse(raw) as Json;
  } catch {
    return placeholder('arguments', raw);
  }
  if (!isObj(args)) return placeholder('arguments', raw);
  const out: Obj = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
    else if (key === 'task_name' && typeof value === 'string') out[key] = taskAlias(value);
    else if (key === 'target' && typeof value === 'string')
      out[key] = value.replace(/[^/]+$/, (last) => (last === 'root' ? last : taskAlias(last)));
    else if (key === 'agent_type' && typeof value === 'string') out[key] = role(value);
    else if (key === 'fork_turns' && typeof value === 'string')
      out[key] = value.length <= 40 ? value : placeholder(key, value);
    // Inter-agent messages are encrypted by Codex. Kept recognisably encrypted,
    // because never showing one is a property the reader must prove.
    else if (key === 'message' && typeof value === 'string' && value.startsWith('gAAAA'))
      out[key] = 'gAAAAA-redacted-ciphertext';
    else if (key === 'cmd' && typeof value === 'string') out[key] = redactCommand(`cmd:"${value}"`);
    else if (key === 'questions' && Array.isArray(value))
      out[key] = value.map((question) =>
        isObj(question)
          ? {
              title: placeholder('question', String(question.title ?? '')),
              options: Array.isArray(question.options)
                ? question.options.map((option) => placeholder('option', String(option)))
                : [],
            }
          : null,
      );
    else out[key] = typeof value === 'string' ? placeholder(key, value) : placeholder(key, '');
  }
  void name;
  return JSON.stringify(out);
};

const agentPath = (value: string): string =>
  value
    .split('/')
    .map((segment) => (segment === '' || segment === 'root' ? segment : taskAlias(segment)))
    .join('/');

/** Keys kept verbatim: identifiers, kinds, numbers dressed as strings. */
const STRUCTURAL = new Set([
  'type',
  'role',
  'id',
  'session_id',
  'thread_id',
  'turn_id',
  'root_turn_id',
  'call_id',
  'response_id',
  'parent_thread_id',
  'forked_from_id',
  'agent_thread_id',
  'sender_thread_id',
  'window_id',
  'timestamp',
  'name',
  'namespace',
  'status',
  'model',
  'cli_version',
  'originator',
  'model_provider',
  'thread_source',
  'agent_role',
  'agent_nickname',
  'kind',
  'phase',
  'reason',
  'effort',
  'approval_policy',
  'tool',
  'limit_id',
  'plan_type',
  'collaboration_mode_kind',
  'history_mode',
  'memory_mode',
  'multi_agent_version',
  'current_date',
  'timezone',
  'event_id',
  'client_id',
  'process_id',
  'source',
]);

/** Large opaque blobs the reader never looks inside. */
const DROPPED = new Set([
  'encrypted_content',
  'base_instructions',
  'replacement_history',
  'retained_context',
  'guardian_history',
  'internal_chat_message_metadata_passthrough',
  'thread_settings',
  'full',
  'state',
  'file_system_sandbox_policy',
  'sandbox_policy',
  'permission_profile',
  'active_permission_profile',
  'results',
  'result',
  'images',
  'local_images',
  'text_elements',
]);

const redactValue = (value: Json, key?: string, parent?: Obj): Json => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (key === 'cwd' || key === 'workdir') return scrubPath(value);
    if (key === 'agent_path' || key === 'task_name') return agentPath(value);
    if (key === 'branch') return 'feature/example';
    if (key === 'agent_role') return role(value);
    if (key === 'timezone') return 'UTC';
    if (key === 'commit_hash' || key === 'repository_url') return placeholder(key, value);
    if (key === 'input' && parent?.type === 'custom_tool_call') return redactCommand(value);
    if (key === 'arguments' && parent?.type === 'function_call')
      return redactArguments(String(parent.name ?? ''), value);
    if (key && STRUCTURAL.has(key))
      return value.length <= 80 ? scrubPath(value) : placeholder(key, value);
    return placeholder(key ?? 'value', value);
  }
  if (Array.isArray(value)) {
    // A parsed command read keeps its shape for the skill detector.
    if (key === 'parsed_cmd')
      return value.map((item): Json =>
        isObj(item) && typeof item.path === 'string' && /\/SKILL\.md$/.test(item.path)
          ? {
              type: 'read',
              path: item.path.replace(
                /skills\/([\w.-]+)\/SKILL\.md$/,
                (_m, skill: string) => `skills/${skillAlias(skill)}/SKILL.md`,
              ),
            }
          : { type: isObj(item) ? String(item.type ?? 'unknown') : 'unknown' },
      );
    if (key === 'command')
      return value.map((part) =>
        typeof part === 'string' && part.startsWith('/') ? part : redactCommand(String(part)),
      );
    if (key === 'runtime_workspace_roots' || key === 'workspace_roots')
      return value.map((part) => (typeof part === 'string' ? scrubPath(part) : null));
    return value.map((item) => redactValue(item, key, parent));
  }
  const out: Obj = {};
  for (const [k, v] of Object.entries(value)) {
    if (DROPPED.has(k)) continue;
    if (k === 'git' && isObj(v)) {
      out[k] = { branch: 'feature/example' };
      continue;
    }
    if (k === 'changes' && isObj(v)) {
      out[k] = Object.fromEntries(
        Object.keys(v).map((path, index) => [
          `/home/user/project/file-${index + 1}`,
          { type: 'update' },
        ]),
      );
      continue;
    }
    out[k] = redactValue(v, k, value);
  }
  return out;
};

type Rollout = { path: string; lines: Obj[]; meta: Obj };

const findRollouts = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) out.push(full);
    }
  };
  if (existsSync(SESSIONS_DIR)) walk(SESSIONS_DIR);
  return out;
};

const firstMeta = (path: string): Obj | undefined => {
  const head = readFileSync(path, 'utf8').split('\n', 1)[0] ?? '';
  try {
    const line = JSON.parse(head) as Json;
    return isObj(line) && line.type === 'session_meta' && isObj(line.payload)
      ? line.payload
      : undefined;
  } catch {
    return undefined;
  }
};

const isGuardian = (meta: Obj): boolean => {
  const source = meta.source;
  return isObj(source) && isObj(source.subagent) && source.subagent.other === 'guardian';
};

const readLines = (path: string): Obj[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Json;
        return isObj(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });

const parseArgs = (argv: string[]): Record<string, string | boolean> => {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[arg.slice(2)] = next;
      i += 1;
    } else out[arg.slice(2)] = true;
  }
  return out;
};

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Where a subagent's own work begins, after the parent history it replays. */
const ownStart = (lines: Obj[], threadId: string): number => {
  const index = lines.findIndex(
    (line) =>
      isObj(line.payload) &&
      line.payload.type === 'task_started' &&
      typeof line.payload.turn_id === 'string' &&
      UUID_V7.test(line.payload.turn_id) &&
      line.payload.turn_id >= threadId,
  );
  return index < 0 ? 0 : index;
};

const kindOf = (line: Obj) =>
  `${String(line.type)}/${isObj(line.payload) ? String(line.payload.type ?? '') : ''}`;

/**
 * Lines worth keeping from a window of a file: every turn boundary inside it,
 * then everything else in order until the budget runs out. Reasoning is dropped
 * and token counts thinned — they are most of a file and all alike.
 */
const keepWindow = (lines: Obj[], budget: number): Obj[] => {
  let tokenCounts = 0;
  const kept: Obj[] = [];
  for (const line of lines) {
    const k = kindOf(line);
    if (k === 'response_item/reasoning') continue;
    if (k === 'event_msg/token_count' && (tokenCounts += 1) % 4 !== 0) continue;
    const essential = k === 'event_msg/task_started' || k === 'event_msg/task_complete';
    if (essential || kept.length < budget) kept.push(line);
  }
  return kept;
};

/**
 * A root keeps its identity line and a window of its history. A subagent keeps
 * its identity line, the head of the parent history it replays — so the reader
 * can be shown ignoring it — and then its own work.
 */
const trim = (thread: Rollout, budget: number, from: number): Obj[] => {
  const [meta, ...rest] = thread.lines;
  if (!meta) return [];
  if (thread.meta.thread_source !== 'subagent') {
    return [meta, ...keepWindow(rest.slice(Math.max(0, from - 1), from - 1 + budget * 3), budget)];
  }
  const start = ownStart(thread.lines, String(thread.meta.id));
  const replay = thread.lines.slice(1, Math.min(start, 26));
  return [meta, ...replay, ...keepWindow(thread.lines.slice(start), budget)];
};

const main = (): void => {
  const args = parseArgs(process.argv.slice(2));
  const rollouts = findRollouts();

  if (args.list) {
    const bySession = new Map<
      string,
      { files: number; bytes: number; version: string; cwd: string }
    >();
    for (const path of rollouts) {
      const meta = firstMeta(path);
      if (!meta || isGuardian(meta)) continue;
      const id = String(meta.session_id ?? meta.id);
      const entry = bySession.get(id) ?? { files: 0, bytes: 0, version: '', cwd: '' };
      entry.files += 1;
      entry.bytes += statSync(path).size;
      if (meta.thread_source !== 'subagent') {
        entry.version = String(meta.cli_version ?? '');
        entry.cwd = basename(String(meta.cwd ?? ''));
      }
      bySession.set(id, entry);
    }
    for (const [id, s] of [...bySession.entries()].sort((a, b) => a[1].bytes - b[1].bytes)) {
      console.log(
        `${id}  ${(s.bytes / 1024).toFixed(0).padStart(7)} KB  ${String(s.files).padStart(3)} threads  ${s.version.padEnd(20)} ${s.cwd}`,
      );
    }
    return;
  }

  const sessionId = typeof args.session === 'string' ? args.session : undefined;
  const name = typeof args.name === 'string' ? args.name : undefined;
  const budget = typeof args['max-lines'] === 'string' ? Number(args['max-lines']) : 400;
  // Where the root's window opens. Long sessions are interesting in the middle.
  const from = typeof args.from === 'string' ? Number(args.from) : 1;
  const maxSubagents =
    typeof args['max-subagents'] === 'string' ? Number(args['max-subagents']) : 4;
  if (!sessionId || !name) {
    console.error('Usage: pnpm fixture:codex -- --session <rootSessionId> --name <fixture-name>');
    process.exitCode = 1;
    return;
  }

  const threads: Rollout[] = [];
  for (const path of rollouts) {
    const meta = firstMeta(path);
    if (!meta || isGuardian(meta)) continue;
    if ((meta.session_id ?? meta.id) !== sessionId) continue;
    threads.push({ path, lines: readLines(path), meta });
  }
  if (threads.length === 0) {
    console.error(`No rollout for session ${sessionId} under ${SESSIONS_DIR}`);
    process.exitCode = 1;
    return;
  }

  // Only the subagents spawned inside the root's window: the rest would be
  // threads whose parent turn the fixture does not contain.
  const root = threads.find((thread) => thread.meta.thread_source !== 'subagent');
  const window = root?.lines.slice(Math.max(1, from), from + budget * 3) ?? [];
  const opens = String(window[0]?.timestamp ?? '');
  const closes = String(window.at(-1)?.timestamp ?? '\uffff');
  const selected = threads
    .filter(
      (thread) =>
        thread === root ||
        (String(thread.meta.timestamp) >= opens && String(thread.meta.timestamp) <= closes),
    )
    .sort((a, b) => String(a.meta.timestamp).localeCompare(String(b.meta.timestamp)))
    .slice(0, maxSubagents + 1);
  threads.length = 0;
  threads.push(...selected);

  setCwds(
    threads.flatMap((thread) =>
      thread.lines.flatMap((line) => {
        const payload = line.payload;
        return isObj(payload) && typeof payload.cwd === 'string' ? [payload.cwd] : [];
      }),
    ),
  );

  const outDir = join(FIXTURES_DIR, name);
  mkdirSync(outDir, { recursive: true });

  const written = threads
    .sort((a, b) => String(a.meta.timestamp).localeCompare(String(b.meta.timestamp)))
    .map((thread, index) => {
      const role = thread.meta.thread_source === 'subagent' ? `subagent-${index}` : 'root';
      const lines = trim(thread, budget, from).map((line) => redactValue(line));
      return {
        file: `${role}.jsonl`,
        content: lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
        of: thread.lines.length,
        kept: lines.length,
      };
    });

  const leaks: string[] = [];
  for (const file of written) {
    for (const word of forbidden)
      if (file.content.includes(word)) leaks.push(`${file.file}: "${word}"`);
    if (/"text":"(?!\[redacted)/.test(file.content))
      leaks.push(`${file.file}: unredacted text field`);
  }
  if (leaks.length > 0) {
    console.error('Refusing to write: redacted output still contains identifying strings.\n');
    for (const leak of [...new Set(leaks)].slice(0, 20)) console.error(`  ${leak}`);
    process.exitCode = 1;
    return;
  }

  for (const file of written) writeFileSync(join(outDir, file.file), file.content);
  const manifest = {
    name,
    recordedAt: new Date().toISOString(),
    harness: 'codex',
    cliVersion: String(
      threads.find((t) => t.meta.thread_source !== 'subagent')?.meta.cli_version ?? 'unknown',
    ),
    files: written.map(({ file, kept, of }) => ({ file, kept, of })),
    recorderHash: createHash('sha256')
      .update(readFileSync(new URL(import.meta.url), 'utf8'))
      .digest('hex')
      .slice(0, 12),
    redaction:
      'Record types, ids, turn and call ids, timestamps, tool names, agent roles and token counts ' +
      'kept. Messages, commands, outputs, paths, task and skill names replaced; reasoning dropped. ' +
      'Review by hand before committing.',
  };
  writeFileSync(join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote ${outDir}`);
  for (const file of written)
    console.log(`  ${file.file.padEnd(16)} ${file.kept} of ${file.of} lines`);
  console.log(
    `\nVerified against ${forbidden.length} identifying strings. Review before committing.`,
  );
};

main();
