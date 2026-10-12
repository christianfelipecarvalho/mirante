import { describe, expect, it, vi } from 'vitest';
import { InstructionTranslations, type InstructionTranslation } from './instruction-translation.js';

const translated = (text: string): InstructionTranslation => ({
  ok: true,
  text,
  sourceLanguage: 'en',
  translated: true,
});

describe('local instruction translation requests', () => {
  it('cancels obsolete language requests without caching their cancellation or cancelling a replacement reader', async () => {
    const signals: AbortSignal[] = [];
    const client = new InstructionTranslations((_text, _target, signal) => {
      signals.push(signal);
      return new Promise((done) =>
        signal.addEventListener('abort', () => done({ ok: false, reason: 'failed' }), {
          once: true,
        }),
      );
    });
    const unsubscribe = client.subscribe('Review the canvas.', 'pt', () => {});
    const pending = client.get('Review the canvas.', 'pt');
    unsubscribe();
    const replacement = client.subscribe('Review the canvas.', 'pt', () => {});
    await Promise.resolve();
    expect(signals[0]!.aborted).toBe(false);
    replacement();
    await Promise.resolve();
    expect(signals[0]!.aborted).toBe(true);
    await pending;
    const again = client.get('Review the canvas.', 'pt');
    expect(signals).toHaveLength(2);
    const off = client.subscribe('Review the canvas.', 'pt', () => {});
    off();
    await again;
  });
  it('invalidates all mounted readers of a failed translation without touching another language', () => {
    const client = new InstructionTranslations(async () => ({ ok: false, reason: 'unavailable' }));
    const header = vi.fn(),
      body = vi.fn(),
      english = vi.fn();
    const unsubscribe = client.subscribe('Review the canvas.', 'pt', header);
    client.subscribe('Review the canvas.', 'pt', body);
    client.subscribe('Review the canvas.', 'en', english);
    client.invalidate('Review the canvas.', 'pt');
    expect(header).toHaveBeenCalledTimes(1);
    expect(body).toHaveBeenCalledTimes(1);
    expect(english).not.toHaveBeenCalled();
    unsubscribe();
    client.invalidate('Review the canvas.', 'pt');
    expect(header).toHaveBeenCalledTimes(1);
    expect(body).toHaveBeenCalledTimes(2);
  });
  it('shares a pending request and cached full text between heading and reader', async () => {
    let finish!: (value: InstructionTranslation) => void;
    const transport = vi.fn(() => new Promise<InstructionTranslation>((done) => (finish = done)));
    const client = new InstructionTranslations(transport);
    const heading = client.get('Review the canvas.', 'pt');
    const reader = client.get('Review the canvas.', 'pt');
    expect(heading).toBe(reader);
    finish(translated('Revise o canvas.'));
    expect(await reader).toMatchObject({ text: 'Revise o canvas.' });
    expect(await client.get('Review the canvas.', 'pt')).toMatchObject({
      text: 'Revise o canvas.',
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('keeps languages independent when an older translation finishes late', async () => {
    const finishes: ((value: InstructionTranslation) => void)[] = [];
    const transport = vi.fn(
      () => new Promise<InstructionTranslation>((done) => finishes.push(done)),
    );
    const client = new InstructionTranslations(transport);
    const pt = client.get('Review the canvas.', 'pt');
    const en = client.get('Review the canvas.', 'en');
    finishes[1]!({ ok: true, text: 'Review the canvas.', sourceLanguage: 'en', translated: false });
    expect(await en).toMatchObject({ text: 'Review the canvas.', translated: false });
    finishes[0]!(translated('Revise o canvas.'));
    await pt;
    expect(await client.get('Review the canvas.', 'en')).toMatchObject({
      text: 'Review the canvas.',
    });
  });

  it('limits simultaneous work and releases the queue even on failure', async () => {
    const finishes: ((value: InstructionTranslation) => void)[] = [];
    const transport = vi.fn(
      () => new Promise<InstructionTranslation>((done) => finishes.push(done)),
    );
    const client = new InstructionTranslations(transport);
    const requests = ['one', 'two', 'three'].map((text) => client.get(text, 'pt'));
    expect(transport).toHaveBeenCalledTimes(2);
    finishes[0]!({ ok: false, reason: 'failed' });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(3));
    finishes[1]!(translated('dois'));
    finishes[2]!(translated('três'));
    expect(await Promise.all(requests)).toEqual([
      { ok: false, reason: 'failed' },
      translated('dois'),
      translated('três'),
    ]);
  });

  it('retries an unavailable translation explicitly and bounds the retained text cache', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
      .mockImplementation(async (text: string) => translated(text));
    const client = new InstructionTranslations(transport, 2);
    expect(await client.get('one', 'pt')).toEqual({ ok: false, reason: 'unavailable' });
    client.invalidate('one', 'pt');
    expect(await client.get('one', 'pt')).toMatchObject({ ok: true });
    await client.get('two', 'pt');
    await client.get('three', 'pt');
    await client.get('one', 'pt');
    expect(transport).toHaveBeenCalledTimes(5);
  });
});
