import { describe, expect, it } from 'vitest';
import { agentIcon } from './icons.js';

describe('agent icons', () => {
  it('reads the most specific part of a compound name', () => {
    // A fleet of review-* agents that all share one glyph tells you nothing
    // about which is which.
    const glyphs = ['review-frontend', 'review-backend', 'review-security', 'review-docs'].map(
      (type) => agentIcon(type, 'a1'),
    );
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it('stays monochrome, so the identity colour is not overridden by the font', () => {
    const types = ['explore', 'review-frontend', 'security', 'whatever-custom', 'main'];
    for (const type of types) {
      const glyph = agentIcon(type, 'a1');
      // Emoji live above the BMP or carry a variation selector; these must not.
      expect([...glyph].every((char) => (char.codePointAt(0) ?? 0) < 0x1f000)).toBe(true);
      expect(glyph).not.toMatch(/️/);
    }
  });

  it('is deterministic for an unknown agent', () => {
    expect(agentIcon('some-custom-agent', 'a1')).toBe(agentIcon('some-custom-agent', 'a2'));
  });

  it('honours an override', () => {
    expect(agentIcon('explore', 'a1', { explore: '✹' })).toBe('✹');
  });
});
