import { describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, projectBoard, totalTokens, type MiranteEvent } from '@mirante/shared';
import { loadFixture } from '../../../../../tests/helpers/fixtures.js';
import { parseSessionTranscript } from './parse.js';

const fixture = loadFixture('subagent-fanout');
const { events: drafts } = parseSessionTranscript({
  mainLines: fixture.mainLines,
  subagents: fixture.subagents,
});

// The event log assigns identity on append; this is that step, done in memory.
const events: MiranteEvent[] = drafts.map((draft, index) => ({
  ...draft,
  id: index + 1,
  receivedTs: draft.ts,
})) as MiranteEvent[];

const board = projectBoard(events);
const lane = board.sessions[0];

describe('rebuilding the board from disk alone', () => {
  it('produces exactly one lane for the session', () => {
    // No daemon was running when this session happened. ADR-0004: the transcript
    // is the spine, so the board is reconstructible without a single hook.
    expect(board.sessions).toHaveLength(1);
    expect(lane?.projectName).toBeTruthy();
    expect(lane?.entrypoint).toBe('vscode');
  });

  it('shows the root card plus one card per subagent, root first', () => {
    expect(lane?.cards[0]?.agentId).toBe(MAIN_AGENT_ID);
    expect(lane?.cards).toHaveLength(fixture.subagents.length + 1);
  });

  it('gives every subagent card a type and a parent', () => {
    const subagentCards = lane?.cards.filter((c) => c.agentId !== MAIN_AGENT_ID) ?? [];
    expect(subagentCards.length).toBeGreaterThan(0);
    for (const card of subagentCards) {
      expect(card.agentType).toBeTruthy();
      expect(card.parentAgentId).toBe(MAIN_AGENT_ID);
    }
  });

  it('does not leave the root card blocked on agents that ran asynchronously', () => {
    expect(lane?.cards[0]?.status.state).not.toBe('waiting_subagent');
  });

  it('writes a handoff line naming who finished and who it went back to', () => {
    // M1 acceptance criterion 3.
    const handoffs = board.timeline.filter((t) => t.kind === 'handoff.end');
    expect(handoffs.length).toBe(fixture.subagents.length);
    for (const entry of handoffs) expect(entry.text).toMatch(/ → main$/);
  });
});

describe('token totals on the board', () => {
  it('sums the lane to the same figure as its cards', () => {
    // M1 acceptance criterion 4, at the projection level: the lane header and the
    // cards under it must not disagree.
    const fromCards = (lane?.cards ?? []).reduce((sum, card) => sum + totalTokens(card.tokens), 0);
    expect(
      totalTokens(lane?.tokens ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }),
    ).toBe(fromCards);
    expect(fromCards).toBeGreaterThan(0);
  });

  it('attributes spend to subagents, not only to the root card', () => {
    const subagentSpend = (lane?.cards ?? [])
      .filter((c) => c.agentId !== MAIN_AGENT_ID)
      .reduce((sum, card) => sum + totalTokens(card.tokens), 0);
    expect(subagentSpend).toBeGreaterThan(0);
  });
});

describe('the timeline', () => {
  it('is ordered and replayable by event id', () => {
    const ids = board.timeline.map((t) => t.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('carries the activity a person would actually want to see', () => {
    const kinds = new Set(board.timeline.map((t) => t.kind));
    expect(kinds.has('handoff.start')).toBe(true);
    expect(kinds.has('handoff.end')).toBe(true);
    expect(kinds.has('tool')).toBe(true);
  });
});
