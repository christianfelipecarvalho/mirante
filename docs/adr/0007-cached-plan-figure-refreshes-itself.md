# ADR-0007 — Plan limits refresh themselves while agents work

- **Status:** accepted
- **Date:** 2026-09-21
- **Amends:** [ADR-0006](0006-plan-limits-on-demand.md) — its "no timer" rule for `/usage`

## Context

ADR-0006 made plan limits on demand only: the one way to read them outside the terminal was
to run Claude Code's `/usage`, and a timer would have had Mirante occasion that command
indefinitely in the background.

The person using Mirante then asked for the limits to update on their own, keeping a button
for an on-demand read. A first implementation re-read only the figure Claude Code caches in
`~/.claude.json`, every minute, on the premise that Claude Code rewrites that figure every turn.

**The premise was wrong, and was measured to be.** The cache was written at 11:54:09 and
11:56:07 UTC, each within seconds of a `/usage` run, and then not again for 171 minutes that
included ordinary work in two sessions. Claude Code writes that figure when `/usage` fetches
it, not as it works. The earlier impression came from reading the cache right after running
`/usage` probes. A timer that only reads the cache updates nothing on its own.

## Options put to the person

1. Run `/usage` every minute, only while an agent is working.
2. Run `/usage` every minute, always.
3. Go back to the button only.

They chose the first.

## Decision

Every 60 seconds, **only while some agent is working**, the daemon runs `/usage`. "Working"
is the rule the board's loading bar uses: a card that is thinking or running a tool, heard
from in the last 30 minutes, in a session that has not ended. With nothing working, nothing
runs — plan usage rises only when requests are made, so reading it while idle would spend a
process to learn nothing. The "reached zero" moment needs no reading either: the board works
it out from the reset time.

Each tick also re-reads the cached figure, which is free, so a figure refreshed by someone
opening `/usage` by hand is picked up too. The "Read now" button runs `/usage` at once.

### What it costs, plainly

- **No tokens.** Measured on every run: `total_cost_usd: 0`, `duration_api_ms: 0`,
  `num_turns: 0`, all token counts zero, and the response marked `local_command: "usage"`.
- **A process.** A Claude Code instance for 3–7 seconds, once a minute of work.
- **Traffic, by Claude Code.** It asks Anthropic for the account's usage and makes the calls
  it always makes on start. Mirante itself still makes no outbound call; ADR-0005 holds.
- **No trace in the person's history.** Each run removes the one transcript it leaves: the
  file named for the session id the command reports, in the probe's own directory.

### Safeguards

- **If `/usage` ever costs tokens, it stops.** A response not handled as a local command is
  a distinct failure, never papered over with the cache, and the first one ends the automatic
  reading for the life of the daemon rather than paying for it once a minute.
- **One at a time.** The timer and the button share a single slot.
- **Opt-in.** Only the daemon the CLI starts turns the timer on.
- **Tests never see the real file.** A suite-wide setup points `CLAUDE_CONFIG_DIR` at an
  empty directory; a test asserts it. This was found the hard way: a test read a real 83%.
- **The file itself.** Parsed only when its inode, size or mtime changed; never above 16 MB;
  refused if cached for another account or stamped in the future; only the two windows leave
  it, through a strict schema; nothing from it is ever logged. `CLAUDE_CONFIG_DIR` is
  followed, as Claude Code follows it.
- **One row per figure.** A cached figure carries the key `plan.usage.cache:<fetchedAtMs>`,
  checked against the log, so restarts and the button do not duplicate it; after a `/usage`
  run the fresh cache is recorded, not the command's prose as well.
- **The newest reading wins.** The status line, the cache and the command arrive out of
  order; the projector keeps the latest by time, and keeps the status line's spend limit.

Claude Code lists `~/.claude.json` among its own sensitive paths. Reading it on a timer is
acceptable for the reasons it was on a click, and no others: the read is local, the
extraction is fixed and tested, and nothing read is logged, stored beyond the two windows,
or sent anywhere.

## Consequences

- While agents work, the meters are at most a minute behind. When nothing runs, the figure
  ages visibly; its age is the time since agents last worked.
- `MIRANTE_PLAN_POLL_MS` sets the interval, floored at 60 s because Claude Code will not
  fetch more often (`T0t`, verified in its binary); `0` turns the automatic reading off.
- The status line still appends a row on every refresh. That is a larger source of log
  growth than this timer, and a separate question.
