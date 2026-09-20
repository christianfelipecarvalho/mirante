import { describe, expect, it } from 'vitest';
import { projectBoard, type MiranteEvent, type MiranteEventOf } from '@mirante/shared';
import { loadFixture } from '../../../../../tests/helpers/fixtures.js';
import { parseSessionTranscript } from './parse.js';

/**
 * Regression: a transcript does not begin with the conversation.
 *
 * Every session on disk opens with bookkeeping records — bridge-session,
 * queue-operation, mode, ai-title — that carry no cwd, no entrypoint and
 * sometimes no timestamp. Reading session identity off the first line produced
 * lanes with a blank project name and an unknown entrypoint, which only showed
 * up against live data because the other fixture starts mid-session.
 */
const fixture = loadFixture('session-start');
const parsed = parseSessionTranscript({
  mainLines: fixture.mainLines,
  subagents: fixture.subagents,
});

const events: MiranteEvent[] = parsed.events.map((draft, index) => ({
  ...draft,
  id: index + 1,
  receivedTs: draft.ts,
})) as MiranteEvent[];

describe('a session read from its very first line', () => {
  it('begins with bookkeeping records that carry no session context', () => {
    // Guards the fixture itself: if a re-recording lost the preamble, this test
    // would pass for the wrong reason.
    const firstTypes = fixture.mainLines.slice(0, 2).map((line) => (line as { type: string }).type);
    expect(firstTypes.every((type) => type !== 'user' && type !== 'assistant')).toBe(true);
  });

  it('takes the project and entrypoint from the first real turn, not the first line', () => {
    const started = events.filter(
      (e): e is MiranteEventOf<'session.started'> => e.kind === 'session.started',
    );
    expect(started).toHaveLength(1);
    expect(started[0]?.payload.cwd).not.toBe('');
    expect(started[0]?.payload.entrypoint).toBe('vscode');
  });

  it('never dates an event to the epoch', () => {
    // Entries with no timestamp used to fall back to 1970, which sorts the whole
    // timeline wrong.
    const epoch = new Date(0).toISOString();
    expect(events.filter((e) => e.ts === epoch)).toEqual([]);
  });

  it('gives the lane a project name to group by', () => {
    const board = projectBoard(events);
    expect(board.sessions).toHaveLength(1);
    expect(board.sessions[0]?.projectName).not.toBe('');
    expect(board.sessions[0]?.entrypoint).toBe('vscode');
  });

  it('still finds the subagents', () => {
    const agents = events.filter((e) => e.kind === 'agent.started');
    expect(agents.length).toBeGreaterThan(0);
  });
});

describe('skill attribution', () => {
  it('records one row per invocation, not one per entry the skill touches', () => {
    // attributionSkill is absent on entries the skill does not cover, so a naive
    // change-detector emits the same skill over and over and buries the timeline.
    const invocations = events.filter((e) => e.kind === 'skill.invoked');
    const perAgent = new Map<string, string[]>();
    for (const event of invocations) {
      const key = event.agentId;
      perAgent.set(key, [
        ...(perAgent.get(key) ?? []),
        (event.payload as { skillName: string }).skillName,
      ]);
    }
    for (const [, skills] of perAgent) {
      // No skill should appear twice in a row for the same agent.
      const repeats = skills.filter((skill, index) => index > 0 && skills[index - 1] === skill);
      expect(repeats).toEqual([]);
    }
  });
});

describe('attributing work to the request that caused it', () => {
  it('carries the turn id from a prompt onto the assistant work that answers it', () => {
    // Only `user` entries carry promptId. Tools and token usage hang off
    // `assistant` entries, so reading the field literally costs every request at
    // zero tools and zero tokens.
    const attributed = events.filter((event) => event.promptId !== undefined);
    const tools = attributed.filter((event) => event.kind === 'tool.started');
    const usage = attributed.filter((event) => event.kind === 'usage.updated');
    expect(tools.length).toBeGreaterThan(0);
    expect(usage.length).toBeGreaterThan(0);
  });

  it('groups a turn under the prompt that opened it, not the one after', () => {
    const prompts = events.filter((event) => event.kind === 'prompt.submitted');
    expect(prompts.length).toBeGreaterThan(0);
    const first = prompts[0];
    const sameTurn = events.filter(
      (event) => event.promptId === first?.promptId && event.ts >= (first?.ts ?? ''),
    );
    expect(sameTurn.length).toBeGreaterThan(1);
  });
});

describe('messages Claude Code writes to itself', () => {
  it('are not counted as requests from a person', () => {
    // Subagent hand-backs and task notifications arrive as ordinary `type: "user"`
    // entries with string content. Counted as requests, they bury the real ones.
    const prompts = events.filter(
      (event): event is MiranteEventOf<'prompt.submitted'> => event.kind === 'prompt.submitted',
    );
    const injected = prompts.filter((event) =>
      /^\s*(<task-notification>|<agent-message|<system-reminder>|\[Subagent hand-back\])/.test(
        event.payload.preview,
      ),
    );
    expect(injected).toEqual([]);
  });
});
