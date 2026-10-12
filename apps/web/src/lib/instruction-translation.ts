export type InstructionLanguage = 'en' | 'pt';
export type InstructionTranslation =
  | {
      ok: true;
      text: string;
      sourceLanguage: InstructionLanguage | 'unknown';
      translated: boolean;
    }
  | { ok: false; reason: 'unavailable' | 'failed' | 'busy' };

type Transport = (
  text: string,
  target: InstructionLanguage,
  signal: AbortSignal,
) => Promise<InstructionTranslation>;

/** One local request per text/language, shared by headings and body readers.
 * Only visible readers enqueue work; bounded parallelism leaves the board live. */
export class InstructionTranslations {
  private readonly cache = new Map<string, InstructionTranslation>();
  private readonly pending = new Map<string, Promise<InstructionTranslation>>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly cancellations = new Map<string, AbortController>();
  private readonly queue: (() => void)[] = [];
  private active = 0;

  constructor(
    private readonly transport: Transport,
    private readonly capacity = 128,
  ) {}

  invalidate(text: string, target: InstructionLanguage): void {
    const key = `${target}\0${text}`;
    this.cache.delete(key);
    this.listeners.get(key)?.forEach((listener) => listener());
  }

  subscribe(text: string, target: InstructionLanguage, listener: () => void): () => void {
    const key = `${target}\0${text}`;
    const listeners = this.listeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
      // React may replace a reader in the same commit. Cancel only after that
      // commit, when no heading/body still needs this language's request.
      queueMicrotask(() => {
        if (!this.listeners.get(key)?.size) this.cancellations.get(key)?.abort();
      });
    };
  }

  get(text: string, target: InstructionLanguage): Promise<InstructionTranslation> {
    const key = `${target}\0${text}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Promise.resolve(cached);
    }
    const pending = this.pending.get(key);
    if (pending && !this.cancellations.get(key)?.signal.aborted) return pending;
    let resolve!: (result: InstructionTranslation) => void;
    const result = new Promise<InstructionTranslation>((done) => {
      resolve = done;
    });
    this.pending.set(key, result);
    const abort = new AbortController();
    this.cancellations.set(key, abort);
    this.queue.push(() => {
      this.active += 1;
      void (
        abort.signal.aborted
          ? Promise.resolve<InstructionTranslation>({ ok: false, reason: 'failed' })
          : this.transport(text, target, abort.signal)
      )
        .catch((): InstructionTranslation => ({ ok: false, reason: 'failed' }))
        .then((value) => {
          if (!abort.signal.aborted) this.cache.set(key, value);
          if (this.cache.size > this.capacity) this.cache.delete(this.cache.keys().next().value!);
          if (this.pending.get(key) === result) this.pending.delete(key);
          if (this.cancellations.get(key) === abort) this.cancellations.delete(key);
          resolve(value);
        })
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    });
    this.pump();
    return result;
  }

  private pump(): void {
    while (this.active < 2 && this.queue.length) this.queue.shift()!();
  }
}
