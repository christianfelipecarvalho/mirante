import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCard, SessionLane } from '@mirante/shared';
import { emptyTokenUsage } from '@mirante/shared';
import { I18nProvider } from './i18n.js';
import {
  agentFlowPath,
  routeAgentFlow,
  reverseAgentFlowPath,
  buildAgentFlow,
  filterInactiveAgents,
  stableAgentCards,
  FLOW_NODE_GAP,
  FLOW_NODE_HEIGHT,
  FLOW_NODE_WIDTH,
  type AgentFlowNode,
} from './agent-flow.js';

// Browser components are typechecked by the web's bundler tsconfig. Load them
// through Vite here so the NodeNext test config does not reinterpret their
// browser imports as Node imports.
type BrowserComponent = ComponentType<{ lane: SessionLane; [prop: string]: unknown }>;
const { AgentFlow } = await vi.importActual<{ AgentFlow: BrowserComponent }>(
  '../components/AgentFlow.js',
);
const { SessionDetail } = await vi.importActual<{ SessionDetail: BrowserComponent }>(
  '../components/SessionDetail.js',
);
const { SessionLaneView } = await vi.importActual<{ SessionLaneView: BrowserComponent }>(
  '../components/SessionLane.js',
);

const card = (agentId: string, parentAgentId?: string): AgentCard => ({
  agentId,
  sessionId: 's1',
  ...(parentAgentId ? { parentAgentId } : {}),
  status: { state: 'thinking' },
  tokens: emptyTokenUsage(),
  startedAt: '2026-10-02T12:00:00.000Z',
  runningChildren: 0,
});

const lane = (cards: AgentCard[]): SessionLane => ({
  sessionId: 's1',
  projectPath: '/tmp/mirante',
  projectName: 'mirante',
  entrypoint: 'cli',
  harness: 'codex',
  startedAt: '2026-10-02T12:00:00.000Z',
  tokens: emptyTokenUsage(),
  cards,
});

describe('buildAgentFlow', () => {
  it('preserves actual parent-child depths in the radial layout', () => {
    const flow = buildAgentFlow(
      lane([
        card('main'),
        card('analyst', 'main'),
        card('architect', 'analyst'),
        card('engineer', 'main'),
      ]),
      Date.parse('2026-10-02T12:01:00.000Z'),
    );
    const nodes = new Map(flow.nodes.map((node) => [node.card.agentId, node]));
    expect(nodes.get('main')?.depth).toBe(0);
    expect(nodes.get('analyst')?.depth).toBe(1);
    expect(nodes.get('architect')?.depth).toBe(2);
    expect(flow.edges).toHaveLength(3);
  });

  it('reverses the signal while a result is returning', () => {
    const child = {
      ...card('analyst', 'main'),
      endedAt: '2026-10-02T12:00:58.000Z',
      status: { state: 'done' } as const,
    };
    const flow = buildAgentFlow(
      lane([card('main'), child]),
      Date.parse('2026-10-02T12:01:00.000Z'),
    );
    expect(flow.edges[0]).toMatchObject({ state: 'returning', direction: 'inbound' });
  });

  it('shows which child blocks a synchronous parent', () => {
    const root = card('main');
    root.status = {
      state: 'waiting_subagent',
      waitingOn: {
        summary: 'Waiting on analyst',
        reason: 'subagent',
        ref: 'analyst',
        since: '2026-10-02T12:00:00.000Z',
      },
    };
    const flow = buildAgentFlow(
      lane([root, card('analyst', 'main')]),
      Date.parse('2026-10-02T12:01:00.000Z'),
    );
    expect(flow.edges[0]).toMatchObject({ state: 'waiting', direction: 'none' });
  });

  it('keeps inactive and silent agents visible without claiming that they are working', () => {
    const idle = card('idle', 'main');
    idle.status = { state: 'idle' };
    const silent = card('silent', 'main');
    const active = card('active', 'main');
    active.lastEventAt = '2026-10-02T13:00:00.000Z';
    const waiting = card('waiting', 'main');
    waiting.status = {
      state: 'waiting_approval',
      waitingOn: { summary: 'Approve the command', since: '2026-10-02T12:00:00.000Z' },
    };
    const flow = buildAgentFlow(
      lane([card('main'), idle, silent, active, waiting]),
      Date.parse('2026-10-02T13:00:00.000Z'),
    );
    expect(
      flow.edges.map(({ childId, state, direction }) => ({ childId, state, direction })),
    ).toEqual([
      { childId: 'idle', state: 'idle', direction: 'none' },
      { childId: 'silent', state: 'silent', direction: 'none' },
      { childId: 'active', state: 'active', direction: 'outbound' },
      { childId: 'waiting', state: 'waiting', direction: 'none' },
    ]);
  });

  it('stops signalling when the session has ended', () => {
    const session = lane([card('main'), card('child', 'main')]);
    session.endedAt = '2026-10-02T12:00:30.000Z';
    const flow = buildAgentFlow(session, Date.parse('2026-10-02T12:01:00.000Z'));
    expect(flow.edges[0]).toMatchObject({ state: 'silent', direction: 'none' });
  });

  it('breaks malformed parent cycles while preserving every node and consistent edges', () => {
    const flow = buildAgentFlow(
      lane([card('main'), card('a', 'b'), card('b', 'a'), card('self', 'self')]),
      Date.parse('2026-10-02T12:01:00.000Z'),
    );
    const nodes = new Map(flow.nodes.map((node) => [node.card.agentId, node]));
    expect(nodes.size).toBe(4);
    expect(flow.edges).toHaveLength(1);
    for (const edge of flow.edges) {
      expect(nodes.get(edge.childId)?.depth).toBe(nodes.get(edge.parentId)!.depth + 1);
    }
    for (const node of flow.nodes) {
      expect(node.x + FLOW_NODE_WIDTH).toBeLessThanOrEqual(flow.width);
      expect(node.y + FLOW_NODE_HEIGHT).toBeLessThanOrEqual(flow.height);
    }
  });

  it('does not invent a parent when the capture omitted it', () => {
    const flow = buildAgentFlow(
      lane([card('main'), card('orphan', 'missing'), card('unknown')]),
      Date.parse('2026-10-02T12:01:00.000Z'),
    );
    expect(flow.nodes).toHaveLength(3);
    expect(flow.edges).toEqual([]);
    expect(flow.nodes.every((node) => node.depth === 0)).toBe(true);
  });

  it('keeps spawn order and parent-first keyboard order through state changes', () => {
    const cards = [card('main'), card('a', 'main'), card('nested', 'a'), card('b', 'main')];
    const before = buildAgentFlow(lane(cards), Date.parse('2026-10-02T12:01:00.000Z'));
    cards[1]!.status = { state: 'done' };
    const after = buildAgentFlow(lane(cards), Date.parse('2026-10-02T12:02:00.000Z'));
    expect(after.nodes.map((node) => node.card.agentId)).toEqual(['main', 'a', 'nested', 'b']);
    expect(after.nodes.map(({ x, y }) => ({ x, y }))).toEqual(
      before.nodes.map(({ x, y }) => ({ x, y })),
    );
  });

  it.each([1, 3, 8, 24, 50])('centers the main and separates a team with %i children', (count) => {
    const flow = buildAgentFlow(
      lane([
        card('main'),
        ...Array.from({ length: count }, (_, index) => card(`child-${index}`, 'main')),
      ]),
      Date.parse('2026-10-02T12:01:00.000Z'),
    );
    const main = flow.nodes.find((node) => node.card.agentId === 'main')!;
    expect(main.x + FLOW_NODE_WIDTH / 2).toBe(flow.width / 2);
    expect(main.y + FLOW_NODE_HEIGHT / 2).toBe(flow.height / 2);
    for (let index = 0; index < flow.nodes.length; index += 1) {
      const node = flow.nodes[index]!;
      for (const other of flow.nodes.slice(index + 1)) {
        const separated =
          Math.abs(node.x - other.x) >= FLOW_NODE_WIDTH + FLOW_NODE_GAP - 0.01 ||
          Math.abs(node.y - other.y) >= FLOW_NODE_HEIGHT + FLOW_NODE_GAP - 0.01;
        expect(separated, `${node.card.agentId} and ${other.card.agentId}`).toBe(true);
      }
    }
    if (count > 8) {
      expect(flow.nodes.filter((node) => node.orbit === 1)).toHaveLength(8);
      expect(flow.nodes.some((node) => node.orbit > 1)).toBe(true);
    }
  });

  it('keeps a nested left branch outside its parent and the main centered in asymmetric trees', () => {
    const flow = buildAgentFlow(
      lane([card('main'), card('right', 'main'), card('left', 'main'), card('nested', 'left')]),
      Date.parse('2026-10-02T12:01:00.000Z'),
    );
    const main = flow.nodes.find((node) => node.card.agentId === 'main')!;
    const left = flow.nodes.find((node) => node.card.agentId === 'left')!;
    const nested = flow.nodes.find((node) => node.card.agentId === 'nested')!;
    expect(nested.x).toBeLessThan(left.x);
    expect(left.x).toBeLessThan(main.x);
    expect(main.x + FLOW_NODE_WIDTH / 2).toBe(flow.width / 2);
    expect(main.y + FLOW_NODE_HEIGHT / 2).toBe(flow.height / 2);
    expect(nested.orbit).toBeGreaterThan(left.orbit);
  });

  it('returns an empty layout when no agents have been observed', () => {
    expect(buildAgentFlow(lane([]), Date.now())).toEqual({
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
    });
  });
});

describe('stable observation order', () => {
  it('keeps coordinates and colour slots when a follow-up reorders the projector snapshot', () => {
    const original = [card('main'), card('a', 'main'), card('b', 'main'), card('c', 'main')];
    const first = stableAgentCards(original, []);
    const before = buildAgentFlow(lane(first.cards), Date.parse('2026-10-02T12:01:00.000Z'));
    const resumed = { ...original[1]!, startedAt: '2026-10-02T12:02:00.000Z' };
    const reordered = stableAgentCards(
      [original[0]!, original[2]!, original[3]!, resumed],
      first.order,
    );
    const after = buildAgentFlow(lane(reordered.cards), Date.parse('2026-10-02T12:02:01.000Z'));
    expect(after.nodes.map(({ card, x, y }) => ({ id: card.agentId, x, y }))).toEqual(
      before.nodes.map(({ card, x, y }) => ({ id: card.agentId, x, y })),
    );
    expect(
      reordered.cards.filter((card) => card.agentId !== 'main').map((card) => card.agentId),
    ).toEqual(['a', 'b', 'c']);
    expect(reordered.cards[1]).toBe(resumed);
    expect(
      stableAgentCards([card('new', 'main'), ...reordered.cards], reordered.order).order,
    ).toEqual(['main', 'a', 'b', 'c', 'new']);
  });
});

describe('filtering inactive canvas nodes', () => {
  it('keeps only recent work and its real ancestors without changing positions', () => {
    const now = Date.parse('2026-10-02T13:00:00.000Z');
    const parent = {
      ...card('finished-parent', 'main'),
      status: { state: 'done' } as const,
      endedAt: '2026-10-02T12:30:00.000Z',
    };
    const active = {
      ...card('active', 'finished-parent'),
      lastEventAt: new Date(now).toISOString(),
    };
    const waiting = (
      id: string,
      state: 'waiting_approval' | 'waiting_input' | 'rate_limited',
    ): AgentCard => ({
      ...card(id, 'main'),
      status: { state, waitingOn: { summary: id, since: new Date(now).toISOString() } },
    });
    const session = lane([
      card('main'),
      parent,
      active,
      { ...card('idle', 'main'), status: { state: 'idle' } },
      card('silent', 'main'),
      { ...card('finished', 'main'), status: { state: 'done' }, outcome: 'ok' },
      waiting('approval', 'waiting_approval'),
      waiting('input', 'waiting_input'),
      waiting('limit', 'rate_limited'),
      {
        ...card('failed', 'main'),
        status: { state: 'error' },
        endedAt: new Date(now).toISOString(),
      },
      { ...card('orphan', 'unknown'), lastEventAt: new Date(now).toISOString() },
    ]);
    const full = buildAgentFlow(session, now);
    const filtered = filterInactiveAgents(full, now);
    expect(new Set(filtered.nodes.map((node) => node.card.agentId))).toEqual(
      new Set(['main', 'finished-parent', 'active', 'orphan']),
    );
    expect(filtered.width).toBe(full.width);
    expect(filtered.height).toBe(full.height);
    for (const node of filtered.nodes)
      expect(node).toBe(
        full.nodes.find((candidate) => candidate.card.agentId === node.card.agentId),
      );
    expect(
      filtered.edges.some(
        (edge) => edge.parentId === 'finished-parent' && edge.childId === 'active',
      ),
    ).toBe(true);
    expect(filtered.edges.some((edge) => edge.childId === 'orphan')).toBe(false);
    expect(full.nodes).toHaveLength(11);
  });

  it('reveals a resumed agent in its original position and stops live claims when the session ends', () => {
    const now = Date.parse('2026-10-02T12:01:00.000Z');
    const child = { ...card('child', 'main'), status: { state: 'idle' } as AgentCard['status'] };
    const session = lane([card('main'), child]);
    const before = buildAgentFlow(session, now);
    expect(filterInactiveAgents(before, now).nodes.map((node) => node.card.agentId)).toEqual([
      'main',
    ]);
    child.status = { state: 'thinking' };
    child.lastEventAt = new Date(now).toISOString();
    const resumed = filterInactiveAgents(buildAgentFlow(session, now), now);
    expect(resumed.nodes.map(({ x, y }) => ({ x, y }))).toEqual(
      before.nodes.map(({ x, y }) => ({ x, y })),
    );
    expect(filterInactiveAgents(resumed, now, true).nodes.map((node) => node.card.agentId)).toEqual(
      ['main'],
    );
  });
});

describe('radial connections', () => {
  it.each([24, 64, 100])(
    'routes %i children around unrelated cards without moving the layout',
    (count) => {
      const now = Date.parse('2026-10-02T12:01:00.000Z');
      const flow = buildAgentFlow(
        lane([
          card('main'),
          ...Array.from({ length: count }, (_, index) => card(`worker-${index}`, 'main')),
        ]),
        now,
      );
      const paths = routeAgentFlow(flow);
      expect([...paths.values()].some((path) => path.points.length > 2)).toBe(true);
      // Independent segment/rectangle clipping checks the rendered polylines,
      // rather than assuming a corner detour clears the intervening cards.
      const hits = (
        a: { x: number; y: number },
        b: { x: number; y: number },
        node: AgentFlowNode,
      ) => {
        let low = 0;
        let high = 1;
        for (const [start, delta, min, max] of [
          [a.x, b.x - a.x, node.x, node.x + FLOW_NODE_WIDTH],
          [a.y, b.y - a.y, node.y, node.y + FLOW_NODE_HEIGHT],
        ] as const) {
          if (Math.abs(delta) < 1e-8) {
            if (start < min || start > max) return false;
            continue;
          }
          const t1 = (min - start) / delta;
          const t2 = (max - start) / delta;
          low = Math.max(low, Math.min(t1, t2));
          high = Math.min(high, Math.max(t1, t2));
          if (low >= high) return false;
        }
        return high > 0 && low < 1;
      };
      for (const edge of flow.edges) {
        const path = paths.get(edge.id)!;
        const reverse = reverseAgentFlowPath(path);
        expect(reverse.points).toEqual(path.points.toReversed());
        expect(reverse.midpoint).toEqual(path.midpoint);
        for (const point of path.points) {
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThanOrEqual(flow.width);
          expect(point.y).toBeLessThanOrEqual(flow.height);
        }
        for (let index = 1; index < path.points.length; index += 1) {
          for (const node of flow.nodes) {
            if (node.card.agentId === edge.parentId || node.card.agentId === edge.childId) continue;
            expect(
              hits(path.points[index - 1]!, path.points[index]!, node),
              `${edge.id} through ${node.card.agentId}`,
            ).toBe(false);
          }
        }
      }
      const coordinates = flow.nodes.map(({ x, y }) => [x, y]);
      const stopped = {
        ...flow,
        nodes: flow.nodes.map((node, index) =>
          index === 1
            ? {
                ...node,
                card: {
                  ...node.card,
                  endedAt: new Date(now).toISOString(),
                  outcome: 'ok' as const,
                  status: { state: 'done' as const },
                },
              }
            : node,
        ),
      };
      const filtered = filterInactiveAgents(stopped, now);
      expect(filtered.nodes.length).toBeLessThan(flow.nodes.length);
      // Routing always uses the complete topology: hidden obstacles still own
      // their corridor, so retained paths are identical after a stop/resume.
      expect(routeAgentFlow(stopped)).toEqual(paths);
      expect(flow.nodes.map(({ x, y }) => [x, y])).toEqual(coordinates);
    },
  );

  it.each([
    [500, 0],
    [-500, 0],
    [0, 400],
    [0, -400],
    [400, 300],
    [-400, -300],
  ])('meets card rectangles for offset %i,%i and reverses on handback', (x, y) => {
    const from: AgentFlowNode = { card: card('main'), depth: 0, orbit: 0, x: 600, y: 500 };
    const to: AgentFlowNode = {
      card: card('child', 'main'),
      depth: 1,
      orbit: 1,
      x: from.x + x,
      y: from.y + y,
    };
    const forward = agentFlowPath(from, to);
    const reverse = agentFlowPath(to, from);
    const onBorder = (point: { x: number; y: number }, node: AgentFlowNode) =>
      Math.max(
        Math.abs(point.x - node.x - FLOW_NODE_WIDTH / 2) / (FLOW_NODE_WIDTH / 2),
        Math.abs(point.y - node.y - FLOW_NODE_HEIGHT / 2) / (FLOW_NODE_HEIGHT / 2),
      );
    expect(onBorder(forward.from, from)).toBeCloseTo(1);
    expect(onBorder(forward.to, to)).toBeCloseTo(1);
    expect(reverse.from).toEqual(forward.to);
    expect(reverse.to).toEqual(forward.from);
    expect(forward.path).not.toContain('NaN');
  });
});

afterEach(() => vi.unstubAllGlobals());

const browser = (search = '') => {
  vi.stubGlobal('window', {
    location: { search },
    localStorage: { getItem: () => 'en' },
  });
};

describe('the tree is visible where the team is observed', () => {
  it.each([
    { outcome: 'interrupted', badge: 'Interrupted', footer: 'interrupted' },
    { outcome: 'error', badge: 'Error', footer: 'Error' },
    { outcome: 'ok', badge: 'Done', footer: 'finished' },
    { outcome: undefined, badge: 'Ended', footer: 'completion unknown' },
  ] as const)(
    'distinguishes $outcome completion and hides closed agents from the working filter',
    ({ outcome, badge, footer }) => {
      browser();
      const now = Date.parse('2026-10-02T12:01:00.000Z');
      const observed: AgentCard = {
        ...card('child', 'main'),
        status: { state: outcome === 'error' ? 'error' : 'done' },
        endedAt: '2026-10-02T12:00:30.000Z',
        ...(outcome ? { outcome } : {}),
      };
      const session = lane([card('main'), observed]);
      const filtered = filterInactiveAgents(buildAgentFlow(session, now), now);
      expect(filtered.nodes.some((node) => node.card.agentId === 'child')).toBe(false);
      const html = renderToStaticMarkup(
        createElement(I18nProvider, { children: createElement(AgentFlow, { lane: session, now }) }),
      );
      const node = html.match(/<button[^>]*data-agent-id="child"[\s\S]*?<\/button>/)?.[0];
      expect(node).toContain(badge);
      expect(node).toContain(footer);
      if (outcome !== 'ok') expect(node).not.toContain('>finished<');
    },
  );

  it('renders the tree directly on the board, including nested and finished agents', () => {
    browser();
    const finished = card('finished', 'nested');
    finished.status = { state: 'done' };
    finished.endedAt = '2026-10-02T12:00:30.000Z';
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        children: createElement(SessionLaneView, {
          lane: lane([card('main'), card('nested', 'main'), finished]),
          approvals: [],
          definitions: new Map(),
          onDecide: () => {},
          onOpen: () => {},
          now: Date.parse('2026-10-02T12:01:00.000Z'),
        }),
      }),
    );
    expect(html).toContain('data-compact="true"');
    expect(html).toContain('data-agent-id="main"');
    expect(html).toContain('data-agent-id="nested"');
    expect(html).toContain('data-agent-id="finished"');
    expect(html.match(/class="agent-flow-edge"/g)).toHaveLength(2);
    expect(html).toContain('Working only');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('Filter map agents');
  });

  it.each(['', '?tab=invalid'])('defaults the session detail to the tree for %s', (search) => {
    browser(search);
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        children: createElement(SessionDetail, {
          lane: lane([card('main')]),
          events: [],
          approvals: [],
          definitions: new Map(),
          onDecide: () => {},
          onClose: () => {},
        }),
      }),
    );
    expect(html).toContain('class="agent-flow-shell');
    expect(html).toContain('data-agent-id="main"');
  });

  it.each([
    { state: 'thinking', life: 'working', beam: true, label: 'Thinking' },
    { state: 'tool_running', life: 'working', beam: true, label: 'Running' },
    { state: 'idle', life: 'idle', beam: false, label: 'Idle' },
    { state: 'waiting_approval', life: 'waiting', beam: false, label: 'Needs approval' },
    { state: 'done', life: 'closed', beam: false, label: 'Ended' },
    { state: 'thinking', life: 'silent', beam: false, label: 'No signal', stale: true },
    { state: 'thinking', life: 'silent', beam: false, label: 'No signal', sessionEnded: true },
    {
      state: 'thinking',
      life: 'closed',
      beam: false,
      label: 'completion unknown',
      agentEnded: true,
    },
  ] as const)('keeps canvas illumination honest for $state / $life', (scenario) => {
    browser();
    const observed = card('main');
    observed.status =
      scenario.state === 'waiting_approval'
        ? {
            state: scenario.state,
            waitingOn: {
              reason: 'approval',
              summary: 'Approval needed',
              since: observed.startedAt,
            },
          }
        : { state: scenario.state };
    if ('agentEnded' in scenario) observed.endedAt = '2026-10-02T12:00:30.000Z';
    const session = lane([observed]);
    if ('sessionEnded' in scenario) session.endedAt = '2026-10-02T12:00:30.000Z';
    for (const compact of [false, true]) {
      const html = renderToStaticMarkup(
        createElement(I18nProvider, {
          children: createElement(AgentFlow, {
            lane: session,
            compact,
            now: Date.parse(
              'stale' in scenario ? '2026-10-02T13:00:00.000Z' : '2026-10-02T12:01:00.000Z',
            ),
          }),
        }),
      );
      const node = html.match(/<button\b[^>]*data-agent-id="main"[^>]*>/)?.[0];
      expect(node).toContain(`data-life="${scenario.life}"`);
      expect(node).toContain(`data-beam="${scenario.beam}"`);
      expect(html).toContain(scenario.label);
      if (scenario.life === 'waiting') expect(node).toContain('--glow:var(--status-warning)');
    }
  });

  it('shows what a node is awaiting and labels silent nodes as no signal', () => {
    browser();
    const waiting = card('approval', 'main');
    waiting.status = {
      state: 'waiting_approval',
      waitingOn: {
        reason: 'approval',
        subject: 'Bash',
        detail: 'Run the migration',
        summary: 'Approval for migration',
        since: '2026-10-02T12:00:00.000Z',
      },
    };
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        children: createElement(AgentFlow, {
          lane: lane([card('main'), waiting, card('silent', 'main')]),
          now: Date.parse('2026-10-02T13:00:00.000Z'),
        }),
      }),
    );
    expect(html).toContain('Run the migration');
    expect(html).toContain('No signal');
    expect(html).not.toContain('data-life="working"');
  });
});
