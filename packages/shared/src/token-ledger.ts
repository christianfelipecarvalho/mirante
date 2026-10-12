import type { DraftEvent, MiranteEventOf } from './event.js';
import { sourceOutranks } from './dedupe.js';
import { addTokenUsage, emptyTokenUsage, type TokenUsage } from './usage.js';

type UsageEvent = Extract<DraftEvent, { kind: 'usage.updated' }> | MiranteEventOf<'usage.updated'>;
const difference = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input - b.input,
  output: a.output - b.output,
  cacheCreation: a.cacheCreation - b.cacheCreation,
  cacheRead: a.cacheRead - b.cacheRead,
  ...(a.thinking !== undefined || b.thinking !== undefined
    ? { thinking: (a.thinking ?? 0) - (b.thinking ?? 0) }
    : {}),
});

/** Incremental response accounting shared by board and turn summaries. apply()
 * returns a signed delta, never a new additive bill. Repaired responses retire
 * legacy per-entry charges even when old events arrive after the repair. */
export class TokenLedger {
  private readonly reports = new Map<string, UsageEvent>();
  private readonly retired = new Set<string>();

  apply(event: UsageEvent): TokenUsage {
    if (event.payload.scope !== 'agent') return emptyTokenUsage();
    const prefix = JSON.stringify([event.sessionId, event.agentId]);
    const identity = event.payload.responseId
      ? `response:${event.payload.responseId}`
      : (event.dedupeKey ??
        ('id' in event ? `event:${event.id}` : JSON.stringify([event.ts, event.payload])));
    const key = `${prefix}|${identity}`;
    if (this.retired.has(key)) return emptyTokenUsage();
    let delta = emptyTokenUsage();
    for (const replaced of event.payload.replacesUsageKeys ?? []) {
      const alias = `${prefix}|${replaced}`;
      if (alias === key || this.retired.has(alias)) continue;
      this.retired.add(alias);
      const old = this.reports.get(alias);
      if (old) {
        delta = addTokenUsage(delta, difference(emptyTokenUsage(), old.payload.tokens));
        this.reports.delete(alias);
      }
    }
    const previous = this.reports.get(key);
    if (
      previous &&
      (sourceOutranks(previous.source, event.source) ||
        (previous.source === event.source && event.ts < previous.ts))
    )
      return delta;
    // Events without response identity remain additive facts identified by their
    // legacy key. A repeated report of that key is a replacement, not a sum.
    this.reports.set(key, event);
    return addTokenUsage(
      delta,
      difference(event.payload.tokens, previous?.payload.tokens ?? emptyTokenUsage()),
    );
  }
}
