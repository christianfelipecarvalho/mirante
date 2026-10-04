# V2 — Driver mode

**Status: specification. Not implemented. Targeted at M4.**

This document exists in M1 on purpose. Driver mode is the reason the event contract is a hard boundary from the first commit; writing the spec early keeps the observer honest about that boundary.

## What it is

An optional second adapter that uses the **Claude Agent SDK** to create and drive sessions from the Mirante panel itself: send a prompt, switch model and effort, interrupt a turn, fork a session.

## What it is not

It is not a replacement for observer mode, and it is never mandatory. A user who only ever wants to watch their terminal sessions must never be pushed into it. Both adapters can run at the same time; the board shows sessions from both.

## The invariant

> The driver adapter emits **exactly** the event kinds that the observer emits. The UI cannot tell which adapter produced an event.

Concretely, `apps/web` must contain no reference to `source`, no branch on adapter mode, and no driver-only component that reads a raw SDK object. If driver mode requires a new kind, that kind is added to `packages/shared` and the observer learns to emit it too, or it is not added.

## Architecture

```
packages/shared  ──── MiranteEvent ────┐
                                        │
apps/daemon/src/adapters/observer/  ────┤──▶ event log ──▶ projector ──▶ UI
apps/daemon/src/adapters/driver/    ────┘
                  └── Agent SDK session pool
```

The driver adapter owns a pool of SDK sessions. For each, it translates SDK stream messages into `MiranteEvent`s, and translates UI commands into SDK calls.

## Command channel

Observer mode is read-only except for permission decisions. Driver mode adds a command channel, which is new attack surface and is treated as such: same token, same `Origin` validation, and every command is itself recorded in the append-only log.

| Command             | Effect                                                    |
| ------------------- | --------------------------------------------------------- |
| `session.create`    | Starts an SDK session with a given cwd, model, and effort |
| `prompt.send`       | Sends a user prompt to a driven session                   |
| `session.interrupt` | Interrupts the current turn                               |
| `session.configure` | Changes model, effort, or permission mode                 |
| `session.fork`      | Forks from a given event id                               |

Commands are rejected for sessions that the driver does not own. **A driven command can never be sent to an observed terminal session** — Mirante does not inject into a session it did not create.

## Known asymmetry: plan usage

`rate_limits` reaches only the status line, and the status line runs only in the interactive interface, so a driven session never pushes plan usage.

**Probably no longer a gap — to verify before M4.** Plan usage is per account, and since [ADR-0007](adr/0007-cached-plan-figure-refreshes-itself.md) Mirante reads the figure Claude Code caches in `~/.claude.json`, whatever surface produced it. If a session driven through the Agent SDK refreshes that cache as the CLI does — the SDK runs the same executable, but this is unobserved — driven sessions get plan usage for free. Until that is verified, the rule below stands.

This is not a bug to be fixed; it is a property of the surfaces. The UI must render plan usage as "unavailable for this session" rather than zero, and the reason must be discoverable in the interface, not only in the docs. This asymmetry is the strongest single argument for observer-first and is recorded in [ADR-0001](adr/0001-observer-before-driver.md).

## What an agent says

`agent.said` carries the prose an agent writes between its tool calls. The
observer reads it from the `text` blocks of assistant entries; a driven session
gets it from the SDK's assistant messages, which stream the same text. Both
adapters can emit it, which is what makes it a legal kind under the invariant
above.

Thinking is not a kind and must not become one from the driver's side alone.
Streamed reasoning would be available to a driven session and is provably
unavailable to the observer — Claude Code writes the `thinking` block empty
(EVENT_MAP D12) — so a UI showing it would be showing something only one adapter
can produce.

## Preventive budget handoff

The observer advises a checkpoint at 80% usage and a pause at 90%, based on
the tightest known account window for each harness. These are policy margins,
not a prediction that the current assignment will fit. A reading older than
five minutes, an absent reading, or a window that already reset cannot establish
remaining allowance. Plan percentages are not a paid credit balance. Children
share the account allowance; their percentages must never be added together.

The panel exports the observed assignments, states, latest activity and pending
approvals as a local recovery snapshot. It also supplies an instruction to paste
into the coordinator's session: collect progress from active children, save
completed work, changed files, test results, remaining tasks and next steps, then
ask whether to continue and wait for an explicit answer. The snapshot cannot
establish unreported task completion or stop execution. No automatic interrupt
or guaranteed credit reserve exists in observer mode.

For a future driver, budget control must be account-wide and include all active
children. Stop new assignments first, request and persist the handoff while a
conservative reserve remains, then pause owned turns and verify acknowledgements.
Continuing requires an explicit user decision; elapsed time is never consent.
If handoff generation fails, retain the last factual snapshot and mark missing
results as unknown. A pending long tool call can still consume resources.

For Codex, the [official App Server interface](https://learn.chatgpt.com/docs/app-server)
provides `account/rateLimits/read`, usage notifications, `turn/steer` and
`turn/interrupt`. Credit details depend on what the service returns. These
interfaces are a route for a future owned-session adapter; they are not enabled
by reading rollout files and must not be injected into unrelated terminal
sessions. Any network-backed driver requires an explicit change to the current
local-only architecture.

## Open questions

- Whether hooks can be registered on an SDK session, which would let a single ingest path serve both adapters.
- How permission handling in the SDK maps onto the `ask` fallback that observer mode depends on.
- Whether a driven session writes a transcript in the same on-disk layout, which would let the transcript reader serve as the same source of truth.

These must be answered against a real SDK session before M4 work starts. No code is written against assumptions here.
