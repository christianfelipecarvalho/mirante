import { describe, expect, it } from 'vitest';
import {
  clampFlowZoom,
  fitFlowViewport,
  flowStage,
  scrollToFlowPoint,
  visibleFlowBounds,
  worldAtFlowPoint,
} from './flow-viewport.js';
import type { AgentFlowNode, AgentFlowPath } from './agent-flow.js';

const content = { width: 6400, height: 4200 };
describe('canvas viewport geometry', () => {
  it.each([
    { width: 288, height: 380 },
    { width: 1240, height: 720 },
  ])('fits a large visible map within a %j viewport', (viewport) => {
    const bounds = { x: 20, y: 20, width: content.width - 40, height: content.height - 40 };
    const fit = fitFlowViewport(content, viewport, bounds);
    const stage = flowStage(content, viewport, fit.zoom);
    const left = stage.x + bounds.x * fit.zoom - fit.scroll.x;
    const top = stage.y + bounds.y * fit.zoom - fit.scroll.y;
    expect(left).toBeGreaterThanOrEqual(15.9);
    expect(top).toBeGreaterThanOrEqual(15.9);
    expect(left + bounds.width * fit.zoom).toBeLessThanOrEqual(viewport.width - 15.9);
    expect(top + bounds.height * fit.zoom).toBeLessThanOrEqual(viewport.height - 15.9);
  });

  it('frames an asymmetric visible branch, keeping the complete canvas coordinates', () => {
    const viewport = { width: 800, height: 500 };
    const bounds = { x: 3900, y: 1000, width: 1100, height: 600 };
    const fit = fitFlowViewport(content, viewport, bounds);
    const world = worldAtFlowPoint(content, viewport, fit.zoom, fit.scroll, { x: 400, y: 250 });
    expect(world.x).toBeCloseTo(4450);
    expect(world.y).toBeCloseTo(1300);
    expect(fit.zoom).toBeGreaterThan(
      fitFlowViewport(content, viewport, { ...content, x: 0, y: 0 }).zoom,
    );
  });

  it.each([0.4, 1.25, 2])(
    'keeps an off-center pointer over the same world point at %f zoom',
    (zoom) => {
      const viewport = { width: 800, height: 600 };
      const anchor = { x: 140, y: 390 };
      const world = worldAtFlowPoint(content, viewport, 1, { x: 1800, y: 1200 }, anchor);
      const scroll = scrollToFlowPoint(content, viewport, zoom, world, anchor);
      const after = worldAtFlowPoint(content, viewport, zoom, scroll, anchor);
      expect(after.x).toBeCloseTo(world.x);
      expect(after.y).toBeCloseTo(world.y);
    },
  );

  it('centers a map smaller than its viewport and handles pinch midpoint movement', () => {
    const small = { width: 280, height: 220 };
    const viewport = { width: 800, height: 600 };
    expect(fitFlowViewport(small, viewport, { x: 20, y: 20, width: 240, height: 180 }).zoom).toBe(
      1,
    );
    expect(flowStage(small, viewport, 0.5)).toEqual({ width: 800, height: 600, x: 330, y: 245 });
    const world = { x: 3000, y: 2000 };
    const anchor = { x: 430, y: 280 };
    const scroll = scrollToFlowPoint(content, viewport, 1.5, world, anchor);
    expect(worldAtFlowPoint(content, viewport, 1.5, scroll, anchor)).toEqual(world);
  });

  it('clamps limits, invalid input and scroll beyond the canvas safely', () => {
    expect(clampFlowZoom(-1)).toBe(0.02);
    expect(clampFlowZoom(9)).toBe(2);
    expect(clampFlowZoom(NaN)).toBe(1);
    expect(
      scrollToFlowPoint(content, { width: 800, height: 600 }, 1, { x: -200, y: 9000 }),
    ).toEqual({ x: 0, y: 3600 });
    expect(
      fitFlowViewport(
        { width: 0, height: 0 },
        { width: 0, height: 0 },
        { x: 0, y: 0, width: 0, height: 0 },
      ),
    ).toEqual({ zoom: 1, scroll: { x: 0, y: 0 } });
  });

  it('includes visible route detours in fit bounds without including hidden cards', () => {
    const nodes = [{ x: 200, y: 100 } as AgentFlowNode];
    const route = {
      points: [
        { x: 170, y: 150 },
        { x: 440, y: 100 },
      ],
    };
    expect(visibleFlowBounds(nodes, [route as AgentFlowPath])).toEqual({
      x: 170,
      y: 100,
      width: 270,
      height: 180,
    });
  });
});
