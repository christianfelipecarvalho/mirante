import { describe, expect, it } from 'vitest';
import {
  MAIN_AGENT_ID,
  addTokenUsage,
  emptyTokenUsage,
  miranteEventSchema,
  type MiranteEventOf,
} from '@mirante/shared';
import { loadFixture, sumUsageFromRaw } from '../../../../../tests/helpers/fixtures.js';
import { parseSessionTranscript } from './parse.js';
import { DEFAULT_PREVIEW_LENGTH } from '../../core/redact.js';

const fixture = loadFixture('subagent-fanout');
const result = parseSessionTranscript({
  mainLines: fixture.mainLines,
  subagents: fixture.subagents,
});

const of = (kind: string) => result.events.filter((e) => e.kind === kind);

describe('parsing a real session that fans out into subagents', () => {
  it('reads every entry without falling back', () => {
    expect(result.skipped).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it('produces events that satisfy the shared contract', () => {
    // The parser emits drafts; the event log assigns identity. Validating with
    // identity attached is what proves the drafts are contract-shaped.
    for (const [index, event] of result.events.entries()) {
      const parsed = miranteEventSchema.safeParse({
        ...event,
        id: index + 1,
        receivedTs: '2026-09-19T00:00:00.000Z',
      });
      if (!parsed.success) {
        throw new Error(`${event.kind} failed contract: ${parsed.error.issues[0]?.message}`);
      }
    }
    expect(result.events.length).toBeGreaterThan(0);
  });

  it('is ordered chronologically', () => {
    const timestamps = result.events.map((e) => e.ts);
    expect([...timestamps].sort((a, b) => a.localeCompare(b))).toEqual(timestamps);
  });
});

describe('session identity', () => {
  it('records the entrypoint, so terminal and VS Code sessions land in separate lanes', () => {
    const started = of('session.started');
    expect(started).toHaveLength(1);
    expect(started[0]?.payload).toMatchObject({ entrypoint: 'vscode' });
  });

  it('attributes every event to a card', () => {
    expect(result.events.every((e) => e.agentId.length > 0)).toBe(true);
  });
});

describe('handoffs', () => {
  const started = of('agent.started') as MiranteEventOf<'agent.started'>[];

  it('creates one card per spawned subagent, typed from its meta.json', () => {
    // Derived from the fixture rather than hard-coded, so the assertion stays
    // true when the fixture is re-recorded with a different window.
    const expected = new Map(
      fixture.subagents.map((sub) => [sub.agentId, (sub.meta as { agentType?: string }).agentType]),
    );
    expect(started).toHaveLength(expected.size);
    for (const event of started) {
      expect(expected.get(event.agentId)).toBe(event.payload.agentType);
    }
    expect(started.every((e) => e.payload.agentType !== 'unknown')).toBe(true);
  });

  it('links each subagent to its parent through the spawning tool use', () => {
    for (const event of started) {
      expect(event.parentAgentId).toBe(MAIN_AGENT_ID);
      expect(event.payload.toolUseId).toMatch(/^toolu_/);
    }
  });

  it('marks asynchronously launched subagents as async, so the parent is not shown as blocked', () => {
    // status: "async_launched" means the parent keeps working. Rendering it as
    // waiting_subagent would be wrong. See docs/EVENT_MAP.md §6 D3.
    expect(started.every((e) => e.payload.spawnMode === 'async')).toBe(true);
  });

  it('names who the work went back to when an agent finishes', () => {
    const finished = of('agent.finished') as MiranteEventOf<'agent.finished'>[];
    expect(finished.length).toBeGreaterThan(0);
    for (const event of finished) {
      expect(event.payload.handedBackTo).toBe(MAIN_AGENT_ID);
      expect(event.agentId).not.toBe(MAIN_AGENT_ID);
    }
  });

  it('does not render a subagent launch as a tool row', () => {
    const toolNames = (of('tool.started') as MiranteEventOf<'tool.started'>[]).map(
      (e) => e.payload.toolName,
    );
    expect(toolNames).not.toContain('Agent');
  });
});

describe('tools', () => {
  it('names the tool on a result even though the result block only carries an id', () => {
    const finished = of('tool.finished') as MiranteEventOf<'tool.finished'>[];
    expect(finished.length).toBeGreaterThan(0);
    expect(finished.every((e) => e.payload.toolName !== 'unknown')).toBe(true);
  });

  it('pairs every result with a call in the same session', () => {
    const startedIds = new Set(
      (of('tool.started') as MiranteEventOf<'tool.started'>[]).map((e) => e.payload.toolUseId),
    );
    const resultIds = [
      ...(of('tool.finished') as MiranteEventOf<'tool.finished'>[]),
      ...(of('tool.failed') as MiranteEventOf<'tool.failed'>[]),
    ].map((e) => e.payload.toolUseId);
    expect(resultIds.filter((id) => !startedIds.has(id))).toEqual([]);
  });
});

describe('token accounting', () => {
  it('matches a sum taken straight from the files, across main and subagent transcripts', () => {
    // M1 acceptance criterion 4. The two sides are computed by different code
    // paths on purpose: a parser agreeing with itself proves nothing.
    const fromEvents = (of('usage.updated') as MiranteEventOf<'usage.updated'>[])
      .map((e) => e.payload.tokens)
      .reduce(addTokenUsage, emptyTokenUsage());
    const fromFiles = sumUsageFromRaw(fixture);

    expect(fromEvents.input).toBe(fromFiles.input);
    expect(fromEvents.output).toBe(fromFiles.output);
    expect(fromEvents.cacheCreation).toBe(fromFiles.cacheCreation);
    expect(fromEvents.cacheRead).toBe(fromFiles.cacheRead);
    expect(fromFiles.output).toBeGreaterThan(0);
  });

  it('attributes usage to the agent that spent it, not only to the session', () => {
    const usage = of('usage.updated') as MiranteEventOf<'usage.updated'>[];
    const agents = new Set(usage.map((e) => e.agentId));
    expect(agents.size).toBeGreaterThan(1);
    expect(agents.has(MAIN_AGENT_ID)).toBe(true);
  });
});

describe('redaction at ingest', () => {
  it('truncates every preview it stores', () => {
    const previews = result.events.flatMap((e) => {
      const payload = e.payload as Record<string, unknown>;
      return ['preview', 'summary', 'errorPreview', 'description', 'resultPreview']
        .map((key) => payload[key])
        .filter((v): v is string => typeof v === 'string');
    });
    expect(previews.length).toBeGreaterThan(0);
    expect(previews.every((p) => p.length <= DEFAULT_PREVIEW_LENGTH)).toBe(true);
  });
});
