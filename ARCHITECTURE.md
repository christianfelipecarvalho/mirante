# Architecture

Mirante is a local observer. It watches Claude Code sessions that are already running on the machine and renders them as a live board. It never starts, drives, or proxies a session in v1.

## Layers

```
┌─ sources ────────────┐   ┌─ daemon (mirantd) ─────────────────┐   ┌─ web ──────┐
│ hooks       (push)   │──▶│ ingest ─▶ normalize ─▶ event log    │──▶│ board      │
│ transcript  (tail)   │──▶│                         (SQLite)    │   │ timeline   │
│ status line (push)   │──▶│            └─▶ projector ─▶ state   │──▶│ top bar    │
│ otel        (M2)     │──▶│                                      │   │ approvals  │
└──────────────────────┘   └──────────────────────────────────────┘   └────────────┘
```

Everything crossing from `ingest` to `event log` is a `MiranteEvent` defined in `packages/shared`. That contract is the seam between v1 (observer) and v4/M4 (driver): the SDK adapter will emit the same event kinds, and the UI cannot tell which mode produced them.

## Packages

| Path                 | Responsibility                                                            |
| -------------------- | ------------------------------------------------------------------------- |
| `packages/shared`    | The event contract, Zod schemas, the card state machine. No I/O.          |
| `packages/installer` | Settings merge, backup, status line wrapping, `doctor` checks, uninstall. |
| `packages/cli`       | The published `mirante` npm package. Owns the `mirante` binary.           |
| `apps/daemon`        | `mirantd`: ingest, event log, projector, Fastify HTTP + WebSocket.        |
| `apps/web`           | React board served by the daemon.                                         |

## The four sources

### Hooks — primary real-time signal

Registered as `type: "http"` hooks pointing at `127.0.0.1`, with a bearer token. HTTP hooks avoid paying process-spawn cost per event. The installer falls back to `type: "command"` with a tiny POST shim only if the installed Claude Code version does not support HTTP hooks.

Hook payloads carry `session_id`, `transcript_path`, `cwd`, `permission_mode`, `prompt_id`, and — when the hook fires inside a subagent — **`agent_id` and `agent_type`**. Routing an event to the right card is therefore a direct lookup, not a heuristic.

### Transcript JSONL — source of truth

The hook payload provides `transcript_path`; Mirante never guesses it. The reader tails incrementally with a persisted byte offset and reindexes on boot.

**Subagent conversations are not in the parent transcript.** They live in a sibling directory:

```
~/.claude/projects/<project-slug>/<sessionId>/subagents/
├── agent-<agentId>.jsonl        # isSidechain: true, agentId, attributionAgent, attributionSkill
├── agent-<agentId>.meta.json    # { agentType, description, toolUseId, spawnDepth, model }
└── workflows/<runId>/           # local workflow runs
```

`meta.json.toolUseId` matches the `id` of the `Agent` tool-use block in the parent transcript. **The handoff edge is recorded data, not inference.** This is why the transcript reader — not the hook ingest — is the spine of the system: the entire board can be rebuilt from disk alone, with hooks supplying only latency.

This directory layout is an internal detail of Claude Code, not a documented interface. It is isolated behind a versioned adapter; see [ADR-0004](docs/adr/0004-transcript-as-spine.md).

### Status line — the only source of plan usage

Plan limits (`rate_limits.five_hour`, `rate_limits.seven_day`, and sometimes `spend_limit`) reach no other surface. The installer wraps any status line the user already had: the wrapper tees stdin, prints the original command's output unchanged, and fires a non-blocking POST to the daemon.

Two constraints shape that wrapper. Claude Code debounces status line updates at 300 ms and **cancels the in-flight script** when a new update arrives, so the wrapper must never block. And `rate_limits` is absent for API-key users, absent before the first API response of a session, and each window disappears once its `resets_at` passes.

### OpenTelemetry — optional, M2

`CLAUDE_CODE_ENABLE_TELEMETRY=1` with an OTLP endpoint gives a second source for tokens and cost, with `agent.name` attribution on the token and cost counters. The receiver is planned for but not built in M1.

## Event log and projector

The event log is **append-only** with a gapless monotonic `id`. Clients replay from any `id`, so closing and reopening the browser rebuilds the board exactly.

Hooks and the transcript both report the same underlying fact — a tool call, for instance — from different angles and at different times. The log keeps both records, because it is also an audit trail. The **projector** deduplicates using `dedupeKey` (for example `tool.started:toolu_01ABC`) when folding events into board state. Without this, every tool call would appear twice.

## Card states

```
idle · thinking · tool_running · waiting_approval · waiting_input
     · waiting_subagent · rate_limited · done · error
```

Every waiting state must display, in short text, **what** is being waited on. That is the central product requirement, not a visual detail.

- `waiting_subagent` — the parent has a _synchronous_ subagent call open with no result. Subagents launched asynchronously (`status: "async_launched"`) do **not** block the parent; the parent keeps its real state and shows a running-agent count badge instead.
- `waiting_approval` — a permission request is pending in the daemon for that card.
- `waiting_input` — a `Notification` arrived and has not been resolved.
- `rate_limited` — in M1, derived only from status line plan percentage. Detection from transcript errors is unvalidated; see [docs/EVENT_MAP.md](docs/EVENT_MAP.md).

## On-screen approval

A `PreToolUse` hook reaches the daemon, which opens a pending request and flips the card to `waiting_approval`.

The controlling rule comes from the hook documentation: **a hook that exceeds its timeout on `PreToolUse` does not block the call** — it proceeds through the normal permission flow. So:

1. The daemon waits a short, configurable time, always shorter than the hook timeout.
2. If the user clicks, it returns `permissionDecision: "allow"` or `"deny"` with a reason.
3. If nobody clicks, it returns `"ask"` and lets the terminal prompt, marking in the UI that it fell through.
4. The card leaves `waiting_approval` only when a resolution arrives, from either path.

The installed hook sets an explicit short timeout rather than inheriting the 600-second default. Nothing in the design ever depends on holding a hook open.

## Security model

- Bind to `127.0.0.1` only. Never `0.0.0.0`.
- A token generated at install time is required on every request; hooks and the status line carry it.
- The `Origin` header is validated on WebSocket upgrade and on state-changing requests.
- Redaction is applied at **ingest**, before anything reaches SQLite — not at read time.
- No outbound network calls. A CI test asserts this.
