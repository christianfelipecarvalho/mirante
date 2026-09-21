# ADR-0006 — Plan limits are read on demand, never polled

- **Status:** accepted, amended by [ADR-0007](0007-cached-plan-figure-refreshes-itself.md)
- **Date:** 2026-09-20
- **Amends:** [ADR-0005](0005-nothing-leaves-the-machine.md) — does not supersede it

## Context

Plan limits — the 5-hour window and the weekly window — reach exactly one push surface: the status line. The status line runs only in the interactive terminal UI. It does not run in the VS Code extension, in `claude -p`, or in the Agent SDK.

Measured on one machine over a single day:

| Session    | Where             | Events | Token readings | Plan readings |
| ---------- | ----------------- | -----: | -------------: | ------------: |
| `5deef69a` | VS Code extension |   2403 |           1005 |         **0** |
| `6de34b33` | Terminal          |     29 |              8 |         **3** |

Twenty-two hours of work produced no plan data at all, because the work happened in the editor. Telling those users to open a terminal is telling them to change how they work so the dashboard has something to show.

## Options considered

**Estimate the percentage from observed token counts.** Rejected on the evidence. The only usable calibration interval available — the status line moving 52% → 73% over 25 minutes — covered 50,948,111 raw tokens, of which 99.5% were cache reads. If cache reads count toward the limit the ratio is 2.43M tokens per percentage point; if they do not, it is 12.4k. A single interval cannot choose between those, and the limits are not published in tokens, so there is no external number to check against. Worse, the percentage is per **account**: it includes claude.ai in a browser and other devices, which a local token sum can never see. The result would be a confident number that is wrong by an unknown factor — the opposite of what this board is for.

**Poll `/usage` on a timer.** Rejected. It would make Mirante generate activity on its own schedule, indefinitely, in the background — the position from which ADR-0005 says a leak is least likely to be noticed.

## Decision

Mirante reads plan limits **only when the person asks for it**, through one button on the board. Two sources, cheapest first.

**First: the figure Claude Code already cached.** Claude Code keeps its last fetched reading in `~/.claude.json` under `cachedUsageUtilization`. Reading it costs nothing, spawns nothing, and causes no traffic whatsoever. Measured end to end: **21 ms**. (This ADR first said ordinary work refreshes it every turn. It does not: Claude Code writes it when `/usage` runs — see ADR-0007.)

Only two values leave that file — the 5-hour and 7-day windows. The same file holds the account's email and identifiers; the schema that parses it names every field that survives and uses no passthrough, and a test asserts that nothing else comes out. Credentials live in `.credentials.json`, which Mirante never opens.

**Second, when the cache is missing or older than an hour: `/usage`.** Measured at `total_cost_usd: 0`, `duration_api_ms: 0`, `num_turns: 0`, `local_command: "usage"`. It spends no tokens and makes no model call, but it does spawn a process and let Claude Code refresh the figure, so it is the fallback rather than the first move. The adapter refuses to normalize any response whose envelope does not say `local_command: "usage"`, so a version that starts charging for it fails closed instead of quietly billing the user.

What does not change: Mirante makes **no outbound network call** — the ESLint ban on global `fetch` stands, as does the no-outbound-socket test — and never reads a credential or calls `api.anthropic.com`. When the fallback runs, Claude Code may contact Anthropic about the user's own account. That is Claude Code acting at the user's request, but Mirante occasioned it, which is why this ADR exists rather than a comment in the code.

No timer, no interval, no refresh-on-focus, no read at daemon start — for the `/usage`
command. The cached figure is read on a timer since [ADR-0007](0007-cached-plan-figure-refreshes-itself.md).

## Consequences

- **A reading is always ageing, and it is dated when Claude Code fetched it — not when Mirante read it.** Stamping it with the moment of the read would make an hour-old number look live. The board states the age beside the meters, from "just now" upward.
- **A cached figure older than an hour is refused, not shown.** Past that the window may have rolled over entirely, so the reading is not stale so much as unanchored.
- **The probe must not appear on the board it feeds.** Running `claude` fires Mirante's own hooks _and_ writes a transcript. Suppressing the hooks with `--setting-sources project` is not enough on its own: the transcript watcher read the probe back as a session the user never opened. The probe's project directory is therefore excluded from the watcher by slug. Both halves are tested.
- **`--bare` is not an option** for suppressing any of this: it forces `ANTHROPIC_API_KEY` or `apiKeyHelper` and never reads OAuth, so it fails for exactly the subscribers this feature is for.
- **The prose fallback is a versioned adapter.** A window it does not recognize is reported as drift in the daemon log, never silently dropped, and a report it cannot read at all yields "unknown" rather than a partial total.
- **Absence stays distinguishable from zero.** An account with no plan limits, a missing `claude` binary, and a failed command each produce a distinct stated reason under the meters.
- The status line remains a source: it is pushed for free whenever a terminal session is open, and a pulled reading supersedes it by timestamp.

## Amended by

- [ADR-0007](0007-cached-plan-figure-refreshes-itself.md) — at the person's decision, `/usage` now runs every minute **while an agent is working**, and never while idle.
