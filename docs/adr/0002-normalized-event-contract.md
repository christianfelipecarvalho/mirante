# ADR-0002 — A normalized, append-only event contract

- **Status:** accepted
- **Date:** 2026-09-19

## Context

Four sources describe the same reality in four shapes: hook payloads, transcript JSONL entries, status line JSON, and later OTel records. A fifth — the Agent SDK — is coming. The obvious shortcut is to forward raw payloads to the front end and let the UI sort it out.

## Decision

Every source is normalized into a single `MiranteEvent` before it reaches storage or the UI. **No raw hook or transcript field ever reaches the front end.** The log is append-only with a gapless monotonic `id`.

## Design notes

**`agentId` is never optional.** The root card of a session uses the sentinel `'main'`. An optional `agentId` would push an `if` into every consumer.

**`dedupeKey` exists because sources overlap.** A hook and the transcript both report the same tool call, at different times and with different detail. The log keeps both — it is an audit trail — and the **projector** collapses them by `dedupeKey`. Without this, every tool call renders twice.

**`ts` and `receivedTs` are separate.** Hooks arrive before the transcript is flushed. Ordering by arrival time would scramble the timeline; ordering by origin time alone would stall the live view. Both are kept.

## Consequences

- Adding a source means writing a normalizer, not touching the UI.
- Replay from any `id` is free, so reopening the browser reconstructs the board.
- Schema changes to the contract are breaking changes and need an ADR.
- There is a real cost: a field observable in a raw payload is invisible until it is mapped. This is accepted deliberately — it is what keeps the driver phase from forking the UI.
