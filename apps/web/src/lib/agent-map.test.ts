import { describe, expect, it } from 'vitest';
import { emptyTokenUsage, type AgentCard } from '@mirante/shared';
import { buildAgentMap, filterAgentMap, type AgentMap } from './agent-map.js';

const card = (agentId: string, parentAgentId?: string): AgentCard => ({
  agentId,
  sessionId: 'session',
  ...(parentAgentId !== undefined ? { parentAgentId } : {}),
  status: { state: 'thinking' },
  tokens: emptyTokenUsage(),
  startedAt: '2026-10-11T12:00:00.000Z',
  runningChildren: 0,
});

/** A renderer must see each parent before its child, with reciprocal links. */
const expectForest = (map: AgentMap, count: number) => {
  const seen = new Map<string, (typeof map.nodes)[number]>();
  const roots = new Set(map.roots);
  expect(roots.size).toBe(map.roots.length);
  for (const node of map.nodes) {
    const id = node.card.agentId;
    expect(seen.has(id)).toBe(false);
    if (node.parentId !== undefined) {
      const parent = seen.get(node.parentId);
      expect(parent).toBeDefined();
      expect(node.depth).toBe(parent!.depth + 1);
      expect(parent!.childIds).toContain(id);
      expect(roots.has(id)).toBe(false);
    } else {
      expect(roots.has(id)).toBe(true);
      expect(node.depth).toBe(0);
    }
    seen.set(id, node);
  }
  for (const node of map.nodes) {
    expect(new Set(node.childIds).size).toBe(node.childIds.length);
    for (const childId of node.childIds) {
      expect(seen.get(childId)?.parentId).toBe(node.card.agentId);
    }
  }
  expect(seen.size).toBe(count);
};

describe('buildAgentMap', () => {
  it('handles an empty or single-card capture', () => {
    expect(buildAgentMap([])).toEqual({ nodes: [], roots: [] });
    const root = card('main');
    expect(buildAgentMap([root])).toEqual({
      nodes: [{ card: root, depth: 0, childIds: [] }],
      roots: ['main'],
    });
  });

  it('places main first and visits real descendants in received sibling order', () => {
    const map = buildAgentMap([
      card('unlinked'),
      card('grandchild', 'first'),
      card('first', 'main'),
      card('second', 'main'),
      card('main'),
      card('unlinked-child', 'unlinked'),
    ]);
    expect(map.roots).toEqual(['main', 'unlinked']);
    expect(map.nodes.map((node) => [node.card.agentId, node.depth])).toEqual([
      ['main', 0],
      ['first', 1],
      ['grandchild', 2],
      ['second', 1],
      ['unlinked', 0],
      ['unlinked-child', 1],
    ]);
    expectForest(map, 6);
  });

  it('shows filtered parents and absent parents as disconnected roots', () => {
    const map = buildAgentMap([
      card('main'),
      card('visible', 'filtered-out'),
      card('orphan', 'never-observed'),
      card('descendant', 'visible'),
    ]);
    expect(map.roots).toEqual(['main', 'visible', 'orphan']);
    expect(map.nodes[0]!.childIds).toEqual([]);
    expect(map.nodes.find((node) => node.card.agentId === 'visible')?.parentId).toBeUndefined();
    expectForest(map, 4);
  });

  it('keeps main as a root and drops self-parent links', () => {
    const map = buildAgentMap([
      card('parent'),
      card('main', 'parent'),
      card('self', 'self'),
      card('child', 'main'),
    ]);
    expect(map.roots).toEqual(['main', 'parent', 'self']);
    expect(map.nodes[0]).toMatchObject({ depth: 0, childIds: ['child'] });
    expect(map.nodes.find((node) => node.card.agentId === 'parent')?.childIds).toEqual([]);
    expectForest(map, 4);
  });

  it('retains all cards and unaffected links when captures contain multiple cycles', () => {
    const map = buildAgentMap([
      card('main'),
      card('leaf', 'a'),
      card('a', 'b'),
      card('b', 'c'),
      card('c', 'a'),
      card('x', 'y'),
      card('y', 'x'),
    ]);
    expect(map.roots).toEqual(['main', 'c', 'y']);
    expect(map.nodes.map((node) => [node.card.agentId, node.parentId])).toEqual([
      ['main', undefined],
      ['c', undefined],
      ['b', 'c'],
      ['a', 'b'],
      ['leaf', 'a'],
      ['y', undefined],
      ['x', 'y'],
    ]);
    expectForest(map, 7);
  });

  it('uses the first duplicate ID without moving siblings or changing input cards', () => {
    const first = Object.freeze(card('child', 'main'));
    const duplicate = Object.freeze({ ...card('child', 'absent'), task: 'later duplicate' });
    const cards = Object.freeze([first, Object.freeze(card('main')), duplicate]);
    const before = JSON.stringify(cards);
    const map = buildAgentMap(cards);
    expect(map.nodes[1]!.card).toBe(first);
    expect(JSON.stringify(cards)).toBe(before);
    expectForest(map, 2);
  });

  it('builds twelve thousand levels without recursive traversal or ancestor rescans', () => {
    const count = 12_000;
    // Reversed capture order forces parent discovery to traverse the full path.
    const cards = Array.from({ length: count }, (_, index) =>
      card(`agent-${index}`, index === 0 ? undefined : `agent-${index - 1}`),
    ).reverse();
    const map = buildAgentMap(cards);
    expect(map.roots).toEqual(['agent-0']);
    expect(map.nodes).toHaveLength(count);
    expect(map.nodes[0]!.depth).toBe(0);
    expect(map.nodes.at(-1)).toMatchObject({
      card: { agentId: `agent-${count - 1}` },
      depth: count - 1,
      parentId: `agent-${count - 2}`,
      childIds: [],
    });
    for (let index = 1; index < count; index += 1) {
      expect(map.nodes[index]!.parentId).toBe(map.nodes[index - 1]!.card.agentId);
    }
  });

  it('keeps five thousand siblings in order and produces deterministic output', () => {
    const cards = [
      card('main'),
      ...Array.from({ length: 5_000 }, (_, index) => card(`child-${index}`, 'main')),
    ];
    const map = buildAgentMap(cards);
    expect(map.nodes.map((node) => node.card.agentId)).toEqual(cards.map((item) => item.agentId));
    expect(map.nodes[0]!.childIds).toEqual(cards.slice(1).map((item) => item.agentId));
    expect(map.nodes.slice(1).every((node) => node.depth === 1)).toBe(true);
    expect(buildAgentMap(cards)).toEqual(map);
  });
});

describe('filterAgentMap', () => {
  const now = Date.parse('2026-10-11T12:05:00.000Z');

  it('shows only recent thinking and tool work apart from the principal reference', () => {
    const main = { ...card('main'), status: { state: 'idle' } as const };
    const thinking = card('thinking', 'main');
    const tool = { ...card('tool', 'main'), status: { state: 'tool_running' } as const };
    const idle = { ...card('idle', 'main'), status: { state: 'idle' } as const };
    const done = { ...card('done', 'main'), status: { state: 'done' } as const };
    const error = { ...card('error', 'main'), status: { state: 'error' } as const };
    const interrupted = {
      ...card('interrupted', 'main'),
      endedAt: '2026-10-11T12:04:00.000Z',
      outcome: 'interrupted' as const,
    };
    const silent = { ...card('silent', 'main'), startedAt: '2026-10-11T10:00:00.000Z' };
    const waiting = [
      'waiting_approval',
      'waiting_input',
      'waiting_subagent',
      'rate_limited',
    ] as const;
    const map = buildAgentMap([
      main,
      thinking,
      tool,
      idle,
      done,
      error,
      interrupted,
      silent,
      ...waiting.map((state) => ({
        ...card(state, 'main'),
        status: {
          state,
          waitingOn: { summary: 'Waiting', since: '2026-10-11T12:00:00.000Z' },
        },
      })),
    ]);
    const filtered = filterAgentMap(map, now);
    expect(filtered.nodes.map((node) => node.card.agentId)).toEqual(['main', 'thinking', 'tool']);
    expect(filtered.nodes[0]!.childIds).toEqual(['thinking', 'tool']);
    expect(filtered.nodes[0]!.card.status.state).toBe('idle');
    expectForest(filtered, 3);
  });

  it('retains inactive observed ancestors without their inactive siblings', () => {
    const main = { ...card('main'), status: { state: 'done' } as const };
    const waitingParent: AgentCard = {
      ...card('waiting-parent', 'main'),
      status: {
        state: 'waiting_subagent',
        waitingOn: { summary: 'Child', since: '2026-10-11T12:00:00.000Z' },
      },
    };
    const stoppedParent = {
      ...card('stopped-parent', 'waiting-parent'),
      endedAt: '2026-10-11T12:01:00.000Z',
      status: { state: 'done' } as const,
    };
    const sibling = {
      ...card('inactive-sibling', 'waiting-parent'),
      status: { state: 'idle' } as const,
    };
    const map = buildAgentMap([
      main,
      waitingParent,
      sibling,
      stoppedParent,
      card('worker', 'stopped-parent'),
    ]);
    const before = JSON.stringify(map);
    const filtered = filterAgentMap(map, now);
    expect(filtered.nodes.map((node) => node.card.agentId)).toEqual([
      'main',
      'waiting-parent',
      'stopped-parent',
      'worker',
    ]);
    expect(filtered.nodes.map((node) => node.depth)).toEqual([0, 1, 2, 3]);
    expect(filtered.nodes[1]!.childIds).toEqual(['stopped-parent']);
    expect(filtered.nodes[1]!.card).toBe(waitingParent);
    expect(JSON.stringify(map)).toBe(before);
    expectForest(filtered, 4);
  });

  it('keeps active disconnected branches as separate roots and drops inactive roots', () => {
    const map = buildAgentMap([
      { ...card('main'), status: { state: 'idle' } as const },
      { ...card('inactive-root'), status: { state: 'done' } as const },
      card('orphan-worker', 'filtered-parent'),
      { ...card('unlinked-parent'), status: { state: 'idle' } as const },
      card('unlinked-worker', 'unlinked-parent'),
    ]);
    const filtered = filterAgentMap(map, now);
    expect(filtered.roots).toEqual(['main', 'orphan-worker', 'unlinked-parent']);
    expect(filtered.nodes[0]!.childIds).toEqual([]);
    expectForest(filtered, 4);
  });

  it('keeps only the preferred reference when no work remains or the session ended', () => {
    const inactiveMap = buildAgentMap([
      { ...card('other-root'), status: { state: 'idle' } as const },
      { ...card('main'), status: { state: 'done' } as const },
      { ...card('idle-child', 'main'), status: { state: 'idle' } as const },
    ]);
    const inactive = filterAgentMap(inactiveMap, now);
    expect(inactive.roots).toEqual(['main']);
    expectForest(inactive, 1);

    const ended = filterAgentMap(buildAgentMap([card('main'), card('child', 'main')]), now, true);
    expect(ended.nodes.map((node) => node.card.agentId)).toEqual(['main']);
    expect(ended.nodes[0]!.childIds).toEqual([]);
    expectForest(ended, 1);

    const withoutMain = filterAgentMap(
      buildAgentMap([
        { ...card('first-root'), status: { state: 'done' } as const },
        { ...card('second-root'), status: { state: 'idle' } as const },
      ]),
      now,
    );
    expect(withoutMain.roots).toEqual(['first-root']);
    expectForest(withoutMain, 1);
    expect(filterAgentMap(buildAgentMap([]), now)).toEqual({ nodes: [], roots: [] });
  });
});
