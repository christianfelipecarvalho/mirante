import { describe, expect, it } from 'vitest';
import { glowPoint } from './pointer-glow.js';

const card = { left: 100, top: 50, width: 300, height: 120 };

describe('glowPoint', () => {
  it('places the light where the pointer is, in the card’s own pixels', () => {
    expect(glowPoint(card, 160, 80)).toEqual({ x: 60, y: 30 });
  });

  it('holds the light at the edge instead of letting it slide away', () => {
    // A drag keeps reporting positions from outside the card.
    expect(glowPoint(card, 900, 500)).toEqual({ x: 300, y: 120 });
    expect(glowPoint(card, 0, 0)).toEqual({ x: 0, y: 0 });
  });
});
