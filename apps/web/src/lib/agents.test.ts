import { describe, expect, it } from 'vitest';
import type { AgentCard } from '@mirante/shared';
import {
  agentOrdinals,
  agentRoleKey,
  agentRoleName,
  agentTaskDetail,
  definitionColor,
  describeAgent,
  inferAgentRole,
} from './agents.js';
import type { Translate } from './i18n.js';

const card = (agentId: string, agentType?: string, task?: string): AgentCard =>
  ({ agentId, ...(agentType ? { agentType } : {}), ...(task ? { task } : {}) }) as AgentCard;

/** Echoes the key, so a test can assert which string was asked for. */
const t = ((key: string) => key) as unknown as Translate;

const nameOf = (c: AgentCard) => describeAgent(c, t).name;

describe('telling agents apart', () => {
  it('numbers them when the name repeats', () => {
    // Two analysts are "Analista 1" and "Analista 2"; numbering by type would
    // put them both under general-purpose along with everything else.
    const ordinals = agentOrdinals(
      [
        card('main'),
        card('a1', 'general-purpose', 'revisar o export'),
        card('a2', 'general-purpose', 'investigar o erro de build'),
        card('a3', 'general-purpose', 'implementar o botão'),
      ],
      nameOf,
    );
    expect([ordinals.get('a1'), ordinals.get('a2')]).toEqual([1, 2]);
  });

  it('leaves a name that appears once unnumbered', () => {
    const ordinals = agentOrdinals(
      [card('main'), card('a3', 'general-purpose', 'implementar o botão')],
      nameOf,
    );
    expect(ordinals.get('a3')).toBeUndefined();
  });

  it('never numbers the session itself', () => {
    expect(agentOrdinals([card('main'), card('main')], nameOf).get('main')).toBeUndefined();
  });
});

describe('agents nothing can identify', () => {
  // The point of "Principal 2" is that it says a second unspecified agent
  // exists — a bare "general-purpose" never would.
  const anonymousCards = [
    card('main'),
    card('a1', 'general-purpose'),
    card('a2', 'general-purpose'),
    card('a3', 'general-purpose'),
  ];

  it('borrow the root name', () => {
    expect(describeAgent(card('a1', 'general-purpose'), t).name).toBe('card.session');
  });

  it('keep their type as small print, so the name is not a claim', () => {
    expect(describeAgent(card('a1', 'general-purpose'), t).typeLabel).toBe('general-purpose');
  });

  it('continue the root numbering from two', () => {
    const ordinals = agentOrdinals(anonymousCards, nameOf);
    expect([ordinals.get('a1'), ordinals.get('a2'), ordinals.get('a3')]).toEqual([2, 3, 4]);
  });

  it('are numbered even when only one of them exists', () => {
    // Otherwise a lone unidentified agent reads as if it were the session.
    const ordinals = agentOrdinals([card('main'), card('a1', 'general-purpose')], nameOf);
    expect(ordinals.get('a1')).toBe(2);
  });

  it('leave the root itself unnumbered', () => {
    expect(agentOrdinals(anonymousCards, nameOf).get('main')).toBeUndefined();
  });

  it('do not disturb agents that can be identified', () => {
    const ordinals = agentOrdinals(
      [
        card('main'),
        card('a1', 'general-purpose'),
        card('a2', 'general-purpose', 'revisar o export'),
        card('a3', 'general-purpose', 'analisar o build'),
      ],
      nameOf,
    );
    expect(ordinals.get('a1')).toBe(2);
    expect([ordinals.get('a2'), ordinals.get('a3')]).toEqual([1, 2]);
  });
});

describe('reading a role out of the task', () => {
  it('lets the verb win over the domain word', () => {
    // "analisar o layout" is analysis, not design; "escrever testes" is QA, not
    // development. Reading the noun first gets both wrong.
    expect(inferAgentRole('analisar o layout')).toBe('analyst');
    expect(inferAgentRole('escrever testes para o parser')).toBe('qa');
  });

  it('recognises analysis, in either language', () => {
    expect(inferAgentRole('revisar o export de leads')).toBe('analyst');
    expect(inferAgentRole('investigate the failing test')).toBe('analyst');
    expect(inferAgentRole('análise de performance')).toBe('analyst');
  });

  it('recognises building things', () => {
    expect(inferAgentRole('implementar o botão de export')).toBe('dev');
    expect(inferAgentRole('fix the broken import')).toBe('dev');
  });

  it('recognises the specialist roles', () => {
    expect(inferAgentRole('escrever testes para o parser')).toBe('qa');
    expect(inferAgentRole('documentar o endpoint')).toBe('docs');
    expect(inferAgentRole('desenhar a interface')).toBe('designer');
    expect(inferAgentRole('arquitetura do módulo de billing')).toBe('architect');
  });

  it('says nothing when the task names no action it knows', () => {
    expect(inferAgentRole('faz a coisa toda aí')).toBeUndefined();
    expect(inferAgentRole(undefined)).toBeUndefined();
  });
});

describe('introducing an agent', () => {
  it('prefers a role the task stated outright', () => {
    const identity = describeAgent(card('a1', 'general-purpose', 'Arquiteto: billing'), t);
    expect(identity).toMatchObject({
      name: 'Arquiteto',
      typeLabel: 'general-purpose',
      detail: 'billing',
    });
  });

  it('falls back to the role its verb implies', () => {
    const identity = describeAgent(card('a1', 'general-purpose', 'revisar o export'), t);
    expect(identity.name).toBe('agentRole.analyst');
    expect(identity.typeLabel).toBe('general-purpose');
  });

  it('keeps the type as the name when nothing else is known', () => {
    expect(describeAgent(card('a1', 'security-reviewer'), t).name).toBe('security-reviewer');
  });

  it('calls the root card the main session', () => {
    expect(describeAgent(card('main'), t).name).toBe('card.session');
  });
});

describe('what an agent is for', () => {
  it('distinguishes the session from something it spawned', () => {
    expect(agentRoleKey(card('main'))).toBe('role.session');
    expect(agentRoleKey(card('a1', 'general-purpose'))).toBe('role.general');
  });

  it('is not passed off as a custom agent when Mirante only saw it finish', () => {
    expect(agentRoleKey(card('aff54877'))).toBe('role.unknown');
  });
});

describe('a stated role prefix', () => {
  it('is lifted out of the task', () => {
    expect(agentRoleName('Arquiteto: tutoriais interativos')).toBe('Arquiteto');
    expect(agentTaskDetail('Arquiteto: tutoriais interativos')).toBe('tutoriais interativos');
  });

  it('is refused when it is too long to be a role', () => {
    expect(agentRoleName('Vá até o arquivo e verifique tudo: com atenção')).toBeUndefined();
  });

  it('is refused when nothing follows the colon', () => {
    expect(agentRoleName('Arquiteto:')).toBeUndefined();
  });
});

describe('an agent that declared its own colour', () => {
  it('gets a themed slot, not a raw hex', () => {
    expect(definitionColor({ name: 'a', color: 'purple', scope: 'user' })).toBe('var(--agent-7)');
  });

  it('falls through when it declared none, or an unknown one', () => {
    expect(definitionColor({ name: 'a', scope: 'user' })).toBeUndefined();
    expect(definitionColor({ name: 'a', color: 'chartreuse', scope: 'user' })).toBeUndefined();
  });
});
