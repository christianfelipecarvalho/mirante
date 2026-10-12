import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstructionTranslator, type TranslationInference } from './instruction-translation.js';
import {
  instructionLanguage,
  translationParts,
  translateInstructionFragment,
} from './translation-text.js';

const instances: InstructionTranslator[] = [];
const make = (
  options: {
    infer?: TranslationInference;
    maxQueued?: number;
    timeoutMs?: number;
    cacheEntries?: number;
  } = {},
) => {
  const service = new InstructionTranslator({ modelDir: '/missing-synthetic-models', ...options });
  instances.push(service);
  return service;
};
afterEach(async () => {
  await Promise.all(instances.splice(0).map((service) => service.close()));
  vi.useRealTimers();
});
const english = 'Please review the existing files and preserve the behavior.';

describe('instruction translation boundaries', () => {
  it('round-trips exact whitespace, fences, identifiers, links and long technical tokens', () => {
    const input =
      '  1. Please review `agentId` and apps/web/src/App.tsx.  \r\n\r\n  \t\n```ts\nconst x = 3;\n```\nUse https://example.com/path?q=1 with MY_KEY and [redacted].\n' +
      'z'.repeat(500);
    const parts = translationParts(input);
    expect(parts.map((part) => part.text).join('')).toBe(input);
    const prose = parts
      .filter((part) => !part.protected)
      .map((part) => part.text)
      .join(' ');
    for (const literal of [
      'agentId',
      'apps/web/src/App.tsx',
      'const x',
      'https://',
      'MY_KEY',
      '[redacted]',
    ])
      expect(prose).not.toContain(literal);
    expect(parts.filter((part) => !part.protected).every((part) => part.text.length <= 360)).toBe(
      true,
    );
    expect(
      translationParts('- ')
        .map((part) => part.text)
        .join(''),
    ).toBe('- ');
    expect(translationParts('pnpm run build').every((part) => part.protected)).toBe(true);
    const long = 'Please preserve all the existing behavior and review carefully. '.repeat(1000);
    const longParts = translationParts(long);
    expect(longParts.map((part) => part.text).join('')).toBe(long);
    expect(
      longParts.filter((part) => !part.protected).every((part) => part.text.length <= 360),
    ).toBe(true);
  });

  it('detects instruction language without forcing technical or foreign fragments', () => {
    expect(instructionLanguage(translationParts(english))).toBe('en');
    expect(instructionLanguage(translationParts('Review authentication module'))).toBe('en');
    expect(instructionLanguage(translationParts('Corrigir autenticação'))).toBe('pt');
    expect(
      instructionLanguage(
        translationParts('Por favor revise os arquivos e mantenha o comportamento atual.'),
      ),
    ).toBe('pt');
    for (const text of [
      '`pnpm check`',
      'TypeScript',
      'OK',
      'Bonjour, je voudrais modifier cette application afin de conserver son fonctionnement.',
    ])
      expect(instructionLanguage(translationParts(text))).toBe('unknown');
  });

  it('sends only redacted prose to inference and preserves original technical spans', async () => {
    const infer = vi.fn<TranslationInference>(async (texts) => texts.map((text) => `PT(${text})`));
    const service = make({ infer });
    const result = await service.translate(
      `${english}\n\nRun \`pnpm check\` in apps/web and use sk-${'a'.repeat(24)}.`,
      'pt',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sourceLanguage).toBe('en');
    expect(result.translated).toBe(true);
    expect(result.text).toContain('\n\n');
    expect(result.text).toContain('`pnpm check`');
    expect(result.text).toContain('apps/web');
    expect(result.text).toContain('[redacted]');
    const inputs = infer.mock.calls[0]![0].join(' ');
    expect(inputs).not.toContain('pnpm');
    expect(inputs).not.toContain('apps/web');
    expect(inputs).not.toContain('sk-');
  });

  it('keeps same-language and unknown text without starting a model', async () => {
    const infer = vi.fn<TranslationInference>();
    const service = make({ infer });
    expect(await service.translate(english, 'en')).toMatchObject({
      ok: true,
      translated: false,
      text: english,
    });
    expect(await service.translate('`node --version`', 'pt')).toMatchObject({
      ok: true,
      sourceLanguage: 'unknown',
      translated: false,
    });
    expect(infer).not.toHaveBeenCalled();
    expect(await make().translate(english, 'pt')).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('bounded local translation work', () => {
  it('coalesces requests, serializes inference, reports a full queue and caches the result', async () => {
    let release!: (texts: string[]) => void;
    const infer = vi.fn<TranslationInference>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const service = make({ infer, maxQueued: 1 });
    const first = service.translate(english, 'pt');
    const duplicate = service.translate(english, 'pt');
    expect(duplicate).toBe(first);
    const second = service.translate(english + ' Check tests.', 'pt');
    expect(await service.translate(english + ' Check files.', 'pt')).toEqual({
      ok: false,
      reason: 'busy',
    });
    expect(infer).toHaveBeenCalledTimes(1);
    release(['Revise os arquivos.']);
    await first;
    await vi.waitFor(() => expect(infer).toHaveBeenCalledTimes(2));
    release(['Verifique os testes.']);
    await second;
    expect(await service.translate(english, 'pt')).toMatchObject({
      ok: true,
      text: 'Revise os arquivos.',
    });
    expect(infer).toHaveBeenCalledTimes(2);
  });

  it('expires hung inference and cancels active plus queued work on close', async () => {
    vi.useFakeTimers();
    const infer = vi.fn<TranslationInference>(() => new Promise(() => {}));
    const service = make({ infer, timeoutMs: 50 });
    const first = service.translate(english, 'pt');
    await vi.advanceTimersByTimeAsync(51);
    expect(await first).toEqual({ ok: false, reason: 'failed' });
    expect(infer.mock.calls[0]![3].aborted).toBe(true);
    const active = service.translate(english, 'pt');
    const queued = service.translate(english + ' Check tests.', 'pt');
    await service.close();
    expect(await active).toEqual({ ok: false, reason: 'unavailable' });
    expect(await queued).toEqual({ ok: false, reason: 'unavailable' });
    expect(await service.translate(english, 'pt')).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('rejects malformed model responses and does not cache failures', async () => {
    const infer = vi
      .fn<TranslationInference>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['Revise os arquivos.']);
    const service = make({ infer });
    expect(await service.translate(english, 'pt')).toEqual({ ok: false, reason: 'failed' });
    expect(await service.translate(english, 'pt')).toMatchObject({ ok: true });
    expect(infer).toHaveBeenCalledTimes(2);
  });
});

it('evicts the least recently used translation without mixing target languages', async () => {
  const infer = vi.fn<TranslationInference>(async (texts, _source, target) =>
    texts.map(() => (target === 'pt' ? 'Texto traduzido.' : 'Translated text.')),
  );
  const service = make({ infer, cacheEntries: 1 });
  await service.translate(english, 'pt');
  await service.translate('Por favor revise os arquivos existentes.', 'en');
  await service.translate(english, 'pt');
  expect(infer).toHaveBeenCalledTimes(3);
});

it('translates only exact short clauses and keeps shell commands literal', async () => {
  expect(translateInstructionFragment('e preserve', 'pt', 'en')).toBe('and preserve');
  expect(translateInstructionFragment('and preserve', 'en', 'pt')).toBe('e preserve');
  expect(translateInstructionFragment('Não altere:', 'pt', 'en')).toBe('Do not change:');
  expect(
    translateInstructionFragment('e preserve o comportamento atual', 'pt', 'en'),
  ).toBeUndefined();
  for (const command of [
    '$ custom-tool inspect',
    'ls -la',
    'cat ./file.txt',
    'rg --files',
    'dotnet build ./app.csproj',
    'make -j2',
  ]) {
    expect(translationParts(command).every((part) => part.protected)).toBe(true);
  }
  expect(
    translationParts('find bugs in the existing implementation').some((part) => !part.protected),
  ).toBe(true);
  const infer = vi.fn<TranslationInference>(async (texts) => texts.map(() => 'SYNTHETIC MODEL'));
  const service = make({ infer });
  const result = await service.translate(
    'Execute `pnpm check` e preserve apps/web/src/App.tsx.',
    'en',
  );
  expect(result).toEqual({
    ok: true,
    text: 'Run `pnpm check` and preserve apps/web/src/App.tsx.',
    sourceLanguage: 'pt',
    translated: true,
  });
  expect(infer).not.toHaveBeenCalled();
  expect(
    await service.translate('Run `pnpm check` and preserve apps/web/src/App.tsx.', 'pt'),
  ).toMatchObject({ ok: true, text: 'Execute `pnpm check` e preserve apps/web/src/App.tsx.' });
});
