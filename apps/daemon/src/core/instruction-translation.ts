import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { scrubSecrets } from './redact.js';
import {
  instructionLanguage,
  translationParts,
  translateInstructionFragment,
  type TranslationLanguage,
} from './translation-text.js';

export type TranslationResult =
  | { ok: true; text: string; sourceLanguage: TranslationLanguage | 'unknown'; translated: boolean }
  | { ok: false; reason: 'unavailable' | 'failed' | 'busy' };
export type TranslationInference = (
  texts: string[],
  source: TranslationLanguage,
  target: TranslationLanguage,
  signal: AbortSignal,
) => Promise<string[]>;
const REVISION = 'marian-q8-prose-v2';
export const TRANSLATION_MODELS = {
  pt: 'Xenova/opus-mt-en-ROMANCE',
  en: 'Xenova/opus-mt-ROMANCE-en',
} as const;

/** One CPU inference at a time, a small queue, and a bounded memory-only cache.
 * No prompt logs, remote provider, model download, or event-store mutation. */
export class InstructionTranslator {
  private worker: Worker | undefined;
  private closed = false;
  private readonly jobs: (() => Promise<void>)[] = [];
  private running = false;
  private readonly pending = new Map<string, Promise<TranslationResult>>();
  private readonly cache = new Map<string, Extract<TranslationResult, { ok: true }>>();
  private readonly cancellations = new Set<AbortController>();
  constructor(
    private readonly options: {
      modelDir: string;
      infer?: TranslationInference;
      timeoutMs?: number;
      maxQueued?: number;
      cacheEntries?: number;
    },
  ) {}

  translate(raw: string, target: TranslationLanguage): Promise<TranslationResult> {
    if (this.closed) return Promise.resolve({ ok: false, reason: 'unavailable' });
    if (raw.length > 64 * 1024) return Promise.resolve({ ok: false, reason: 'failed' });
    const text = scrubSecrets(raw);
    const key = createHash('sha256')
      .update(JSON.stringify([REVISION, target, text]))
      .digest('hex');
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Promise.resolve(cached);
    }
    const pending = this.pending.get(key);
    if (pending) return pending;
    const parts = translationParts(text);
    const source = instructionLanguage(parts);
    if (source === 'unknown' || source === target)
      return Promise.resolve({ ok: true, text, sourceLanguage: source, translated: false });
    if (
      !this.options.infer &&
      ![
        'config.json',
        'tokenizer.json',
        'onnx/encoder_model_quantized.onnx',
        'onnx/decoder_model_merged_quantized.onnx',
      ].every((file) => existsSync(join(this.options.modelDir, TRANSLATION_MODELS[target], file)))
    )
      return Promise.resolve({ ok: false, reason: 'unavailable' });
    if (this.jobs.length >= (this.options.maxQueued ?? 8))
      return Promise.resolve({ ok: false, reason: 'busy' });
    let resolve!: (result: TranslationResult) => void;
    const promise = new Promise<TranslationResult>((done) => {
      resolve = done;
    });
    this.pending.set(key, promise);
    this.jobs.push(async () => {
      if (this.closed) {
        this.pending.delete(key);
        resolve({ ok: false, reason: 'unavailable' });
        return;
      }
      const abort = new AbortController();
      this.cancellations.add(abort);
      let timer: NodeJS.Timeout | undefined;
      let result: TranslationResult;
      try {
        const prepared = parts.map((part) => ({
          ...part,
          literal: part.protected
            ? part.text
            : translateInstructionFragment(part.text, source, target),
        }));
        const snippets = prepared
          .filter((part) => part.literal === undefined)
          .map((part) => part.text);
        const timeout = new Promise<never>((_, reject) => {
          abort.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true,
          });
          timer = setTimeout(() => abort.abort(), this.options.timeoutMs ?? 120_000);
          timer.unref?.();
        });
        const translated = await Promise.race([
          snippets.length
            ? (this.options.infer ?? this.infer)(snippets, source, target, abort.signal)
            : Promise.resolve([]),
          timeout,
        ]);
        if (
          translated.length !== snippets.length ||
          translated.some(
            (value) => typeof value !== 'string' || !value.trim() || value.length > 8192,
          )
        )
          throw new Error('invalid translation');
        let index = 0;
        const output = scrubSecrets(
          prepared.map((part) => part.literal ?? translated[index++]!.trim()).join(''),
        );
        if (output.length > 256 * 1024) throw new Error('oversized translation');
        result = { ok: true, text: output, sourceLanguage: source, translated: output !== text };
        this.cache.set(key, result);
        while (this.cache.size > (this.options.cacheEntries ?? 64))
          this.cache.delete(this.cache.keys().next().value!);
      } catch {
        result = { ok: false, reason: this.closed ? 'unavailable' : 'failed' };
      } finally {
        if (timer) clearTimeout(timer);
        this.cancellations.delete(abort);
      }
      this.pending.delete(key);
      resolve(result);
    });
    void this.drain();
    return promise;
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length) await this.jobs.shift()!();
    } finally {
      this.running = false;
    }
  }

  private infer: TranslationInference = (texts, source, target, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('cancelled'));
        return;
      }
      if (!this.worker) {
        const fresh = new Worker(new URL('./translation-worker.js', import.meta.url), {
          workerData: { modelDir: this.options.modelDir },
          stdout: true,
          stderr: true,
        });
        this.worker = fresh;
        // Also handle an idle worker dying between requests, without diagnostics.
        const clear = () => {
          if (this.worker === fresh) this.worker = undefined;
        };
        fresh.on('error', clear);
        fresh.on('exit', clear);
      }
      const worker = this.worker;
      // Do not forward runtime/model diagnostics, which can contain source text.
      worker.stdout?.resume();
      worker.stderr?.resume();
      const cleanup = () => {
        worker.off('message', message);
        worker.off('error', error);
        worker.off('exit', exit);
        signal.removeEventListener('abort', abort);
      };
      const fail = () => {
        cleanup();
        if (this.worker === worker) this.worker = undefined;
        void worker.terminate();
        reject(new Error('translation failed'));
      };
      const message = (result: { ok: boolean; texts?: string[] }) => {
        if (!result.ok || !Array.isArray(result.texts)) {
          fail();
          return;
        }
        cleanup();
        resolve(result.texts);
      };
      const error = () => fail();
      const exit = () => fail();
      const abort = () => fail();
      worker.once('message', message);
      worker.once('error', error);
      worker.once('exit', exit);
      signal.addEventListener('abort', abort, { once: true });
      worker.postMessage({ texts, source, target });
    });

  async close(): Promise<void> {
    this.closed = true;
    for (const abort of this.cancellations) abort.abort();
    if (this.worker) {
      const worker = this.worker;
      this.worker = undefined;
      await worker.terminate();
    }
    await Promise.all(this.pending.values());
    this.cache.clear();
  }
}
