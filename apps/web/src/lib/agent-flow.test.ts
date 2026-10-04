import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCard, SessionLane } from '@mirante/shared';
import { emptyTokenUsage } from '@mirante/shared';
import { I18nProvider } from './i18n.js';
import { buildAgentFlow, FLOW_NODE_HEIGHT, FLOW_NODE_WIDTH } from './agent-flow.js';

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
  it('lays nested agents out in parent-child columns', () => {
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

  it('returns an empty layout when no agents have been observed', () => {
    expect(buildAgentFlow(lane([]), Date.now())).toEqual({
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
    });
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
