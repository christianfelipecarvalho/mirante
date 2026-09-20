import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_SLOT_COUNT, NEUTRAL_SLOT, agentColor } from './palette.js';

const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');

describe('agent identity colours', () => {
  it('assigns slots in order and never cycles', () => {
    expect(agentColor(0)).toBe('var(--agent-1)');
    expect(agentColor(AGENT_SLOT_COUNT - 1)).toBe(`var(--agent-${AGENT_SLOT_COUNT})`);
  });

  it('falls back to neutral past the validated slots rather than inventing a hue', () => {
    expect(agentColor(AGENT_SLOT_COUNT)).toBe(NEUTRAL_SLOT);
    expect(agentColor(-1)).toBe(NEUTRAL_SLOT);
  });

  it('defines every slot for both themes', () => {
    // A slot picked in JavaScript would carry one theme's step into the other,
    // so each one has to exist twice in CSS: once per surface.
    for (let slot = 1; slot <= AGENT_SLOT_COUNT; slot += 1) {
      const occurrences = css.split(`--agent-${slot}:`).length - 1;
      expect({ slot, occurrences }).toEqual({ slot, occurrences: 2 });
    }
  });

  it('keeps the two themes on different steps', () => {
    const values = (slot: number) =>
      [...css.matchAll(new RegExp(`--agent-${slot}:\\s*(#[0-9a-f]{6})`, 'g'))].map((m) => m[1]);
    // Green is intentionally the same in both; the rest must differ.
    const shared = [6];
    for (let slot = 1; slot <= AGENT_SLOT_COUNT; slot += 1) {
      const found = values(slot);
      // Assert on the count first: two undefineds compare equal, so a regex that
      // matches nothing would otherwise pass this test silently.
      expect({ slot, found: found.length }).toEqual({ slot, found: 2 });
      if (shared.includes(slot)) continue;
      expect({ slot, same: found[0] === found[1] }).toEqual({ slot, same: false });
    }
  });
});
