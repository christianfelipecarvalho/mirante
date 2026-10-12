import { francAll } from 'franc-min';

export type TranslationLanguage = 'pt' | 'en';
export type TranslationPart = { text: string; protected: boolean };
const technical =
  /(?<ticks>`+)[^\r\n]*?\k<ticks>(?!`)|`+[^\r\n]*$|https?:\/\/[^\s<>"`]+|\[redacted\]|\{\{[^}\r\n]+\}\}|\$\{[^}\r\n]+\}|\b[\w.@~-]+(?:\/[\w.@~+%:-]+)+|(?:[A-Za-z]:\\|\.{0,2}\/)[\w.@~+%\-/\\:]+|\b[\w@-]+\.(?:tsx?|jsx?|jsonl?|md|py|go|rs|css|html|ya?ml|sql|sh|env|lock|txt|toml)(?::\d+)?\b|\b[A-Za-z]+(?:_[A-Za-z0-9]+)+\b|\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\b|\b[A-Z][a-z]+(?:[A-Z][A-Za-z0-9]*)+\b|\b[A-Z][A-Z0-9_]{1,}\b|--[a-z][\w-]*\b/g;

/** Preserve technical spans and line boundaries verbatim. Only prose reaches
 * the model, so generated text cannot rewrite a command, URL or identifier. */
export const translationParts = (text: string): TranslationPart[] => {
  const parts: TranslationPart[] = [];
  const add = (value: string, protectedPart: boolean) => {
    if (value) parts.push({ text: value, protected: protectedPart });
  };
  let fence: string | undefined;
  for (const line of text.split(/(\r\n|\r|\n)/)) {
    if (/^[\r\n]+$/.test(line)) {
      add(line, true);
      continue;
    }
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      add(line, true);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (marker) {
      fence = marker;
      add(line, true);
      continue;
    }
    if (
      /^\s*\$\s+\S/.test(line) ||
      /^\s*(?:ls|cat|rg|dotnet|make)\s+.*(?:--?[A-Za-z]|[./\\])/.test(line) ||
      /^\s*(?:\$ )?(?:pnpm|npm|npx|yarn|git|node|python3?|cargo|go|curl|docker|kubectl)\s+[-\w]/.test(
        line,
      )
    ) {
      add(line, true);
      continue;
    }
    let offset = 0;
    for (const match of line.matchAll(technical)) {
      addProse(line.slice(offset, match.index), add);
      add(match[0], true);
      offset = match.index + match[0].length;
    }
    addProse(line.slice(offset), add);
  }
  return parts;
};

const addProse = (text: string, add: (text: string, protectedPart: boolean) => void) => {
  // Bound model inputs without cutting words or losing whitespace/list markers.
  for (const piece of text.match(/.{1,360}(?:\s+|$)|\S+(?:\s+|$)/g) ?? []) {
    if (!piece.trim()) {
      add(piece, true);
      continue;
    }
    const leading = /^(?:\s*(?:[-*+] |\d+[.)] ))?\s*/.exec(piece)?.[0] ?? '';
    const trailing = /\s*$/.exec(piece)?.[0] ?? '';
    if (leading.length + trailing.length >= piece.length) {
      add(piece, true);
      continue;
    }
    const body = piece.slice(leading.length, piece.length - trailing.length);
    add(leading, true);
    add(body, body.length > 360 || !/\p{L}/u.test(body));
    add(trailing, true);
  }
};

const enWords = new Set(
  'the this that these those with without and or to from for into your you must should please preserve keep change update implement review inspect verify ensure check run tests files before after only do not use return add remove existing following behavior task'.split(
    ' ',
  ),
);
const ptWords = new Set(
  'o os as um uma de do da dos das e ou para com sem você seu sua deve não por favor preserve mantenha altere atualize implemente revise verifique garanta execute testes arquivos antes depois apenas use retorne adicione remova existente seguinte comportamento tarefa'.split(
    ' ',
  ),
);

export const instructionLanguage = (
  parts: readonly TranslationPart[],
): TranslationLanguage | 'unknown' => {
  const prose = parts
    .filter((part) => !part.protected)
    .map((part) => part.text)
    .join(' ');
  const words = prose.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 2) return 'unknown';
  const english = words.filter((word) => enWords.has(word)).length;
  const portuguese = words.filter((word) => ptWords.has(word)).length;
  if (portuguese >= 2 && portuguese > english) return 'pt';
  if (english >= 2 && english > portuguese) return 'en';
  // Short task headings often have only one distinctive imperative. Avoid
  // shared words (use/preserve) and leave ambiguous labels untouched.
  if (
    portuguese === 0 &&
    /^(?:review|inspect|verify|implement|update|remove|fix|check|analyze)\b/i.test(prose.trim())
  )
    return 'en';
  if (
    english === 0 &&
    /^(?:revise|revisar|verifique|verificar|implemente|implementar|atualize|atualizar|corrija|corrigir|analise|analisar)\b/i.test(
      prose.trim(),
    )
  )
    return 'pt';
  if (prose.length < 40 || words.length < 6) return 'unknown';
  const result = francAll(prose, { minLength: 40 })[0]?.[0];
  // Do not force unknown/foreign or code-heavy text into an EN/PT pair.
  if (result === 'eng' && english > 0) return 'en';
  if (result === 'por' && portuguese > 0) return 'pt';
  return 'unknown';
};

// Protecting code splits a sentence into short prose fragments. Marian can
// hallucinate on these incomplete clauses (for example, "e preserve"). Only
// these exact, common instruction fragments use a deterministic translation;
// complete prose remains the model's responsibility. No fuzzy substitution.
const fragmentPairs: readonly (readonly [string, string])[] = [
  ['and preserve', 'e preserve'],
  ['and keep', 'e mantenha'],
  ['and use', 'e use'],
  ['and run', 'e execute'],
  ['and check', 'e verifique'],
  ['and review', 'e revise'],
  ['do not change', 'não altere'],
  ['do not remove', 'não remova'],
  ['do not run', 'não execute'],
  ['do not use', 'não use'],
  ['without changing', 'sem alterar'],
  ['without removing', 'sem remover'],
  ['without running', 'sem executar'],
  ['please review', 'por favor revise'],
  ['please check', 'por favor verifique'],
  ['please run', 'por favor execute'],
  ['run', 'execute'],
  ['preserve', 'preserve'],
  ['keep', 'mantenha'],
  ['use', 'use'],
  ['check', 'verifique'],
  ['review', 'revise'],
  ['update', 'atualize'],
  ['remove', 'remova'],
  ['open', 'abra'],
  ['read', 'leia'],
  ['and', 'e'],
  ['or', 'ou'],
  ['with', 'com'],
  ['without', 'sem'],
  ['in', 'em'],
];

export const translateInstructionFragment = (
  text: string,
  source: TranslationLanguage,
  target: TranslationLanguage,
): string | undefined => {
  if (source === target) return text;
  const match = /^(.*?)([.,;:!?]*)$/.exec(text);
  if (!match) return undefined;
  const body = match[1]!;
  const key = body.toLowerCase();
  const sourceIndex = source === 'en' ? 0 : 1;
  const pair = fragmentPairs.find((entry) => entry[sourceIndex] === key);
  if (!pair) return undefined;
  let translated = pair[sourceIndex === 0 ? 1 : 0];
  if (body[0] !== body[0]?.toLowerCase())
    translated = translated[0]!.toUpperCase() + translated.slice(1);
  return translated + match[2]!;
};
