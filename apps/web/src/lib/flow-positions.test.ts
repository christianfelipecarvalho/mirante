import { describe, expect, it } from 'vitest';
import type { AgentCard } from '@mirante/shared';
import {
  FLOW_NODE_HEIGHT,
  FLOW_NODE_WIDTH,
  FLOW_PADDING,
  agentFlowPath,
  filterInactiveAgents,
  routeAgentFlow,
  type AgentFlow,
} from './agent-flow.js';
import {
  clampFlowPosition,
  draggedFlowPosition,
  MAX_FLOW_POSITION,
  MAX_POSITION_AGENTS,
  MAX_POSITION_SESSIONS,
  nudgedFlowPosition,
  parseFlowPositions,
  positionAgentFlow,
  updateFlowPositions,
} from './flow-positions.js';
import {
  fitFlowViewport,
  flowStage,
  scrollToFlowPoint,
  visibleFlowBounds,
} from './flow-viewport.js';

const now = Date.parse('2026-10-10T15:00:00Z');
const node = (id: string, x: number, y: number, done = false) => ({
  x,
  y,
  depth: id === 'main' ? 0 : 1,
  orbit: 1,
  card: {
    agentId: id,
    sessionId: 'session',
    parentAgentId: id === 'main' ? undefined : 'main',
    tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    runningChildren: 0,
    status: { state: done ? 'done' : 'thinking', since: new Date(now).toISOString() },
    startedAt: new Date(now - 1000).toISOString(),
    lastEventAt: new Date(now).toISOString(),
    ...(done ? { endedAt: new Date(now).toISOString() } : {}),
  } as AgentCard,
});
const graph = (): AgentFlow => ({
  nodes: [node('main', 800, 800), node('child', 1600, 800), node('old', 1200, 800, true)],
  width: 2400,
  height: 1800,
  edges: [
    { id: 'edge', parentId: 'main', childId: 'child', state: 'active', direction: 'outbound' },
  ],
});

describe('manual agent placement', () => {
  it.each([0.02, 0.5, 1, 2])('moves by the same pointer distance at zoom %s', (zoom) => {
    const original = { x: 1000, y: 1000 };
    const moved = draggedFlowPosition(original, { x: 90, y: 40 }, zoom);
    expect((moved.x - original.x) * zoom).toBeCloseTo(90);
    expect((moved.y - original.y) * zoom).toBeCloseTo(40);
  });
  it.each([0.5, 1, 2])('keeps a growing small map under the pointer at %s zoom', (zoom) => {
    const content = { width: 280, height: 220 };
    const viewport = { width: 1100, height: 700 };
    const origin = { x: 20, y: 20 };
    const initial = flowStage(content, viewport, zoom);
    for (const delta of [
      { x: 120, y: 60 },
      { x: 800, y: 500 },
    ]) {
      const point = draggedFlowPosition(origin, delta, zoom, { content, viewport });
      const expanded = {
        width: Math.max(content.width, point.x + FLOW_NODE_WIDTH + FLOW_PADDING),
        height: Math.max(content.height, point.y + FLOW_NODE_HEIGHT + FLOW_PADDING),
      };
      const after = flowStage(expanded, viewport, zoom);
      expect(after.x + point.x * zoom - (initial.x + origin.x * zoom)).toBeCloseTo(delta.x, 4);
      expect(after.y + point.y * zoom - (initial.y + origin.y * zoom)).toBeCloseTo(delta.y, 4);
    }
  });
  it('bounds invalid/extreme movement and supports precise and coarse keyboard moves', () => {
    expect(clampFlowPosition({ x: NaN, y: Infinity })).toEqual({
      x: FLOW_PADDING,
      y: FLOW_PADDING,
    });
    expect(clampFlowPosition({ x: -50, y: 1e12 })).toEqual({
      x: FLOW_PADDING,
      y: MAX_FLOW_POSITION,
    });
    expect(nudgedFlowPosition({ x: 30, y: 50 }, 'ArrowLeft')).toEqual({ x: 20, y: 50 });
    expect(nudgedFlowPosition({ x: 30, y: 50 }, 'ArrowDown', true)).toEqual({ x: 30, y: 130 });
    expect(nudgedFlowPosition({ x: 30, y: 50 }, ' ')).toBeUndefined();
  });
  it('keeps saved coordinates across filtering and snapshots, expanding only the footprint', () => {
    const original = graph();
    const placed = positionAgentFlow(original, {
      main: { x: 200, y: 300 },
      child: { x: 2600, y: 2000 },
    });
    expect(placed.nodes[0]).toMatchObject({ x: 200, y: 300 });
    expect(placed.nodes[2]).toBe(original.nodes[2]);
    expect(placed.width).toBe(2600 + FLOW_NODE_WIDTH + FLOW_PADDING);
    expect(placed.height).toBe(2000 + FLOW_NODE_HEIGHT + FLOW_PADDING);
    expect(original.nodes[0]).toMatchObject({ x: 800, y: 800 });
    const visible = filterInactiveAgents(placed, now, false);
    expect(visible.nodes.map(({ card }) => card.agentId)).toEqual(['main', 'child']);
    expect(visible.nodes[1]).toBe(placed.nodes[1]);
    expect(positionAgentFlow(original, {}).nodes[0]).toBe(original.nodes[0]);
  });
  it('holds the expanded footprint when a card returns inward, then restores the automatic footprint', () => {
    const automatic = graph();
    const outward = positionAgentFlow(automatic, { main: { x: 5000, y: 3000 } });
    const inward = positionAgentFlow(automatic, { main: { x: 200, y: 300 } }, outward);
    expect(inward.nodes[0]).toMatchObject({ x: 200, y: 300 });
    expect(inward.width).toBe(outward.width);
    expect(inward.height).toBe(outward.height);
    const reset = positionAgentFlow(automatic, {});
    expect(reset.width).toBe(automatic.width);
    expect(reset.height).toBe(automatic.height);
  });
  it('routes the visible relationship directly through space vacated by hidden history', () => {
    const all = graph();
    const filtered = filterInactiveAgents(all, now, false);
    expect(routeAgentFlow(all).get('edge')!.points.length).toBeGreaterThan(2);
    expect(routeAgentFlow(filtered).get('edge')!.points).toHaveLength(2);
  });
  it('keeps overlapping/coincident cards and reversed connections finite', () => {
    const main = node('main', 20, 20);
    for (const offset of [0, 0.000001, 20, 200]) {
      const path = agentFlowPath(main, node('child', 20 + offset, 20));
      expect(path.path).not.toMatch(/NaN|Infinity/);
      expect(
        path.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
      ).toBe(true);
      expect(path.midpoint.x).toBeGreaterThanOrEqual(0);
      expect(path.midpoint.y).toBeGreaterThanOrEqual(0);
    }
  });
  it('centers the moved main and fits moved visible nodes at either viewport size', () => {
    const moved = positionAgentFlow(graph(), {
      main: { x: 600, y: 400 },
      child: { x: 950, y: 700 },
    });
    const visible = filterInactiveAgents(moved, now, false);
    const bounds = visibleFlowBounds(visible.nodes, [...routeAgentFlow(visible).values()]);
    for (const viewport of [
      { width: 320, height: 500 },
      { width: 1200, height: 700 },
    ]) {
      const center = scrollToFlowPoint(moved, viewport, 1, { x: 720, y: 490 });
      expect(720 - center.x).toBe(viewport.width / 2);
      expect(490 - center.y).toBe(viewport.height / 2);
      const fit = fitFlowViewport(moved, viewport, bounds);
      const stage = flowStage(moved, viewport, fit.zoom);
      expect(stage.x + bounds.x * fit.zoom - fit.scroll.x).toBeGreaterThanOrEqual(15.9);
      expect(stage.y + (bounds.y + bounds.height) * fit.zoom - fit.scroll.y).toBeLessThanOrEqual(
        viewport.height - 15.9,
      );
    }
  });
});

describe('bounded position preferences', () => {
  it('restores separate sessions and resets just the requested session', () => {
    let stored = updateFlowPositions([], 'a', 'main', { x: 120, y: 200 });
    stored = updateFlowPositions(stored, 'b', 'main', { x: 400, y: 500 });
    const loaded = parseFlowPositions(JSON.stringify({ version: 1, sessions: stored }));
    expect(loaded).toEqual(stored);
    expect(updateFlowPositions(loaded, 'a')).toEqual([stored[1]]);
  });
  it('ignores corrupt storage, unsafe keys and non-finite coordinates', () => {
    expect(parseFlowPositions('{')).toEqual([]);
    expect(parseFlowPositions('{"version":2,"sessions":[]}')).toEqual([]);
    const raw =
      '{"version":1,"sessions":[{"sessionId":"a","positions":{"__proto__":{"x":20,"y":30},"bad":{"x":1e999,"y":30},"good":{"x":-5,"y":500000}}}]}';
    expect(parseFlowPositions(raw)).toEqual([
      { sessionId: 'a', positions: { good: { x: 20, y: MAX_FLOW_POSITION } } },
    ]);
  });
  it('bounds retained sessions and agents while preserving the most recent placements', () => {
    let stored = [] as ReturnType<typeof parseFlowPositions>;
    for (let i = 0; i < MAX_POSITION_SESSIONS + 4; i++)
      stored = updateFlowPositions(stored, String(i), 'main', { x: i + 50, y: 40 });
    expect(stored).toHaveLength(MAX_POSITION_SESSIONS);
    expect(stored[0]!.sessionId).toBe('4');
    const positions = Object.fromEntries(
      Array.from({ length: MAX_POSITION_AGENTS + 2 }, (_, i) => [String(i), { x: 50, y: 80 }]),
    );
    const limited = parseFlowPositions(
      JSON.stringify({ version: 1, sessions: [{ sessionId: 'a', positions }] }),
    );
    expect(Object.keys(limited[0]!.positions)).toHaveLength(MAX_POSITION_AGENTS);
    expect(limited[0]!.positions['0']).toBeUndefined();
  });
});
