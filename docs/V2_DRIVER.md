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

`rate_limits` reaches only the status line, and the status line runs only in the interactive interface. **A driven session has no plan usage data.**

This is not a bug to be fixed; it is a property of the surfaces. The UI must render plan usage as "unavailable for this session" rather than zero, and the reason must be discoverable in the interface, not only in the docs. This asymmetry is the strongest single argument for observer-first and is recorded in [ADR-0001](adr/0001-observer-before-driver.md).

## Open questions

- Whether hooks can be registered on an SDK session, which would let a single ingest path serve both adapters.
- How permission handling in the SDK maps onto the `ask` fallback that observer mode depends on.
- Whether a driven session writes a transcript in the same on-disk layout, which would let the transcript reader serve as the same source of truth.

These must be answered against a real SDK session before M4 work starts. No code is written against assumptions here.
