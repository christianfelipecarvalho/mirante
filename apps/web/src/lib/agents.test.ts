import { describe, expect, it } from 'vitest';
import type { AgentCard } from '@mirante/shared';
import { agentOrdinals, agentRoleKey, definitionColor } from './agents.js';

const card = (agentId: string, agentType?: string): AgentCard =>
  ({ agentId, ...(agentType ? { agentType } : {}) }) as AgentCard;

describe('telling agents of the same type apart', () => {
  it('numbers them when a type repeats', () => {
    // Three cards all reading "general-purpose" cannot be told apart or referred to.
    const ordinals = agentOrdinals([
      card('main'),
      card('a1', 'general-purpose'),
      card('a2', 'general-purpose'),
      card('a3', 'general-purpose'),
    ]);
    expect([ordinals.get('a1'), ordinals.get('a2'), ordinals.get('a3')]).toEqual([1, 2, 3]);
  });

  it('leaves a lone agent unnumbered', () => {
    const ordinals = agentOrdinals([card('main'), card('a1', 'Explore')]);
    expect(ordinals.get('a1')).toBeUndefined();
  });

  it('never numbers the session itself', () => {
    expect(agentOrdinals([card('main'), card('main')]).get('main')).toBeUndefined();
  });
});

describe('saying what an agent is for', () => {
  it('distinguishes the session from something it spawned', () => {
    expect(agentRoleKey(card('main'))).toBe('role.session');
    expect(agentRoleKey(card('a1', 'general-purpose'))).toBe('role.general');
  });

  it('falls back to a custom-agent description rather than to nothing', () => {
    expect(agentRoleKey(card('a1', 'review-frontend'))).toBe('role.custom');
  });
});

describe('an agent that declared its own colour', () => {
  it('gets a themed slot, not a raw hex', () => {
    // A hex from a definition would carry one theme's step onto the other
    // surface; the slot resolves per theme.
    expect(definitionColor({ name: 'a', color: 'purple', scope: 'user' })).toBe('var(--agent-7)');
    expect(definitionColor({ name: 'a', color: 'RED', scope: 'user' })).toBe('var(--agent-8)');
  });

  it('falls through to the assigned slot when it declared none, or an unknown one', () => {
    expect(definitionColor({ name: 'a', scope: 'user' })).toBeUndefined();
    expect(definitionColor({ name: 'a', color: 'chartreuse', scope: 'user' })).toBeUndefined();
    expect(definitionColor(undefined)).toBeUndefined();
  });
});
