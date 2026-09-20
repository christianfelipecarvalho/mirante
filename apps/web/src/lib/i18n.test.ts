import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Reads the dictionaries out of the source rather than importing the module,
 * which pulls in React. The point is to compare the two tables, and a missing
 * key is exactly the kind of thing that never shows up until someone switches
 * language and finds a raw key on screen.
 */
const source = readFileSync(fileURLToPath(new URL('./i18n.tsx', import.meta.url)), 'utf8');

/**
 * One dictionary's source, from its declaration to its own closing brace.
 *
 * The English table closes with `} as const;` and the Portuguese one with `};`,
 * so stopping at the first `};` runs straight through the first table into the
 * second — which makes both look identical and the comparison vacuous.
 */
const bodyOf = (declaration: string): string => {
  const start = source.indexOf(declaration);
  expect(start).toBeGreaterThan(-1);
  const candidates = [source.indexOf('\n} as const;', start), source.indexOf('\n};', start)].filter(
    (index) => index > -1,
  );
  return source.slice(start, Math.min(...candidates));
};

const keysOf = (declaration: string): string[] =>
  [...bodyOf(declaration).matchAll(/^\s{2}'([^']+)':/gm)].map((match) => match[1] as string);

const valuesOf = (declaration: string): Map<string, string> =>
  new Map(
    [...bodyOf(declaration).matchAll(/^\s{2}'([^']+)':\s*'((?:[^'\\]|\\.)*)'/gm)].map((match) => [
      match[1] as string,
      match[2] as string,
    ]),
  );

const english = keysOf('const en = {');
const portuguese = keysOf('const ptBR: Record<Key, string> = {');

describe('the two dictionaries stay in step', () => {
  it('translates every English key', () => {
    expect([...english].filter((key) => !portuguese.includes(key))).toEqual([]);
  });

  it('has no Portuguese key the English side lost', () => {
    expect([...portuguese].filter((key) => !english.includes(key))).toEqual([]);
  });

  it('leaves nothing untranslated by accident', () => {
    const en = valuesOf('const en = {');
    const pt = valuesOf('const ptBR: Record<Key, string> = {');
    const identical = [...en.entries()]
      .filter(([key, value]) => value.length > 0 && pt.get(key) === value)
      // Spelled the same in both languages, or not words at all: abbreviations
      // (tok, ctx), loanwords Portuguese uses as-is (skill, terminal, tokens),
      // and product names.
      .filter(
        ([key]) =>
          ![
            'entry.sdk',
            'entry.print',
            'entry.vscode',
            'entry.cli',
            'timeline.skills',
            'timeline.skill',
            'timeline.repeated',
            'stat.tokens',
            'card.tokens',
            'lane.context',
            'theme.auto',
          ].includes(key),
      );
    expect(identical.map(([key]) => key)).toEqual([]);
  });

  it('uses the same placeholders on both sides', () => {
    const en = valuesOf('const en = {');
    const pt = valuesOf('const ptBR: Record<Key, string> = {');
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, value] of en) {
      const other = pt.get(key);
      if (other === undefined) continue;
      expect({ key, vars: placeholders(other) }).toEqual({ key, vars: placeholders(value) });
    }
  });
});
