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
    for (let slot = 1; slot <= AGENT_SLOT_COUNT; slot += 1) {
      const found = values(slot);
      // Assert on the count first: two undefineds compare equal, so a regex that
      // matches nothing would otherwise pass this test silently.
      expect({ slot, found: found.length }).toEqual({ slot, found: 2 });
      expect({ slot, same: found[0] === found[1] }).toEqual({ slot, same: false });
    }
  });
});

/** WCAG relative luminance for the exact opaque tokens used by the UI. */
const luminance = (hex: string): number => {
  const channels = [1, 3, 5].map((offset) => {
    const srgb = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
};

const contrast = (foreground: string, background: string): number => {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

/** The hover uses the agent hue at 26% alpha over the card surface. */
const hoverSurface = (foreground: string, background: string, alpha = 0.26): string =>
  '#' +
  [1, 3, 5]
    .map((offset) =>
      Math.round(
        Number.parseInt(foreground.slice(offset, offset + 2), 16) * alpha +
          Number.parseInt(background.slice(offset, offset + 2), 16) * (1 - alpha),
      )
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');

describe('readable theme colours', () => {
  const themes = [...css.matchAll(/:root(?:\[data-theme='(light)'\])?\s*\{([^}]+)\}/g)];
  it('finds both theme token sets', () => {
    expect(themes).toHaveLength(2);
  });
  for (const [, theme = 'dark', block = ''] of themes) {
    const tokens = Object.fromEntries(
      [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/g)].map(([, key, value]) => [key, value]),
    );
    it(`keeps text readable at the brightest point of the pointer glow in ${theme}`, () => {
      const hues = [
        'accent',
        'status-warning',
        ...Array.from({ length: AGENT_SLOT_COUNT }, (_, index) => `agent-${index + 1}`),
      ];
      for (const hue of hues) {
        const background = hoverSurface(tokens[hue]!, tokens['surface-1']!);
        for (const foreground of ['text-primary', 'hover-text-secondary', 'hover-text-muted']) {
          expect(
            contrast(tokens[foreground]!, background),
            `${theme}: ${foreground} over ${hue} glow`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`keeps canvas text readable on a lit surface with and without pointer light in ${theme}`, () => {
      const hues = [
        'accent',
        'status-warning',
        ...Array.from({ length: AGENT_SLOT_COUNT }, (_, index) => `agent-${index + 1}`),
      ];
      for (const hue of hues) {
        const litSurface = hoverSurface(tokens[hue]!, tokens['surface-1']!, 0.16);
        for (const background of [litSurface, hoverSurface(tokens[hue]!, litSurface)]) {
          for (const foreground of ['text-primary', 'hover-text-secondary', 'hover-text-muted']) {
            expect(
              contrast(tokens[foreground]!, background),
              `${theme}: ${foreground} on lit ${hue}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    });

    it(`keeps small text, status and agent labels legible in ${theme}`, () => {
      const textTokens = [
        'text-primary',
        'text-secondary',
        'text-muted',
        'accent',
        'status-good',
        'status-warning',
        'status-serious',
        'status-critical',
        ...Array.from({ length: AGENT_SLOT_COUNT }, (_, index) => `agent-${index + 1}`),
      ];
      for (const foreground of textTokens) {
        for (const background of ['surface-1', 'surface-2', 'plane']) {
          expect(
            contrast(tokens[foreground]!, tokens[background]!),
            `${theme}: ${foreground} on ${background}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const background of ['action-good', 'action-critical']) {
        expect(
          contrast('#ffffff', tokens[background]!),
          `${theme}: approval action`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
