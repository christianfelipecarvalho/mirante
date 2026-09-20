import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures', import.meta.url));

export type LoadedFixture = {
  name: string;
  mainLines: unknown[];
  subagents: { agentId: string; meta?: unknown; lines: unknown[] }[];
};

const readJsonl = (path: string): unknown[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);

/** Loads a fixture recorded by `pnpm fixture:record`, in the layout Claude Code writes on disk. */
export const loadFixture = (name: string): LoadedFixture => {
  const dir = join(FIXTURES_DIR, name);
  const subagentsDir = join(dir, 'subagents');

  const subagents: LoadedFixture['subagents'] = [];
  if (existsSync(subagentsDir)) {
    for (const file of readdirSync(subagentsDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const agentId = basename(file, '.jsonl').replace(/^agent-/, '');
      const metaPath = join(subagentsDir, `agent-${agentId}.meta.json`);
      subagents.push({
        agentId,
        ...(existsSync(metaPath)
          ? { meta: JSON.parse(readFileSync(metaPath, 'utf8')) as unknown }
          : {}),
        lines: readJsonl(join(subagentsDir, file)),
      });
    }
  }

  return { name, mainLines: readJsonl(join(dir, 'main.jsonl')), subagents };
};

/**
 * Sums `message.usage` straight from the fixture files, independently of the
 * parser, so the token test compares two different paths to the same number
 * rather than the parser against itself.
 */
export const sumUsageFromRaw = (fixture: LoadedFixture) => {
  const total = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  const add = (lines: unknown[]) => {
    for (const line of lines) {
      const entry = line as { type?: string; message?: { usage?: Record<string, number> } };
      if (entry.type !== 'assistant' || !entry.message?.usage) continue;
      const u = entry.message.usage;
      total.input += u.input_tokens ?? 0;
      total.output += u.output_tokens ?? 0;
      total.cacheCreation += u.cache_creation_input_tokens ?? 0;
      total.cacheRead += u.cache_read_input_tokens ?? 0;
    }
  };
  add(fixture.mainLines);
  for (const sub of fixture.subagents) add(sub.lines);
  return total;
};
