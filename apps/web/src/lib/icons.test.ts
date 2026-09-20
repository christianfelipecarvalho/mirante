import { describe, expect, it } from 'vitest';
import { agentIcon } from './icons.js';

describe('agent icons', () => {
  it('reads the most specific part of a compound name', () => {
    // A fleet of review-* agents that all share one mark tells you nothing
    // about which is which.
    const icons = ['review-frontend', 'review-backend', 'review-security', 'review-docs'].map(
      (type) => agentIcon(type, 'a1'),
    );
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('chooses a mark for what the agent does', () => {
    expect(agentIcon('security-reviewer', 'a1')).toBe('shield');
    expect(agentIcon('qa-runner', 'a1')).toBe('beaker');
    expect(agentIcon('Explore', 'a1')).toBe('search');
  });

  it('marks an agent with no type as unidentified rather than inventing one', () => {
    expect(agentIcon(undefined, 'aff548777a6545ab3')).toBe('unknown');
  });

  it('gives the session its own mark', () => {
    expect(agentIcon(undefined, 'main')).toBe('session');
  });

  it('is deterministic for an unfamiliar agent', () => {
    expect(agentIcon('some-custom-agent', 'a1')).toBe(agentIcon('some-custom-agent', 'a2'));
  });

  it('honours an override', () => {
    expect(agentIcon('explore', 'a1', { explore: 'globe' })).toBe('globe');
  });
});
