import { afterEach, expect, it, vi } from 'vitest';
import { createDaemon, type Daemon } from './index.js';
import { loadConfig } from '../config.js';
import type { TranslationInference } from '../core/instruction-translation.js';
let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
});
it('guards local translation, validates input and never mutates the event history', async () => {
  const infer = vi.fn<TranslationInference>(async (texts) =>
    texts.map(() => 'Revise os arquivos existentes.'),
  );
  daemon = createDaemon({
    config: loadConfig({ databasePath: ':memory:' }),
    token: 'test-token',
    watch: false,
    translationInfer: infer,
  });
  const url = '/api/instructions/translate';
  const payload = { text: 'Please review the existing files.', target: 'pt' };
  expect((await daemon.app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
  const headers = { authorization: 'Bearer test-token' };
  expect(
    (
      await daemon.app.inject({
        method: 'POST',
        url,
        payload,
        headers: { ...headers, origin: 'https://example.com' },
      })
    ).statusCode,
  ).toBe(403);
  for (const invalid of [
    { text: 'x', target: 'fr' },
    { text: 'x'.repeat(65537), target: 'en' },
  ])
    expect(
      (await daemon.app.inject({ method: 'POST', url, payload: invalid, headers })).statusCode,
    ).toBe(400);
  expect(infer).not.toHaveBeenCalled();
  const before = daemon.projector.snapshot();
  const response = await daemon.app.inject({ method: 'POST', url, payload, headers });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    ok: true,
    text: 'Revise os arquivos existentes.',
    sourceLanguage: 'en',
    translated: true,
  });
  expect(daemon.projector.snapshot()).toEqual(before);
});
