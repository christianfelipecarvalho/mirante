# ADR-0004 — The transcript reader is the spine, hooks are the latency layer

- **Status:** accepted
- **Date:** 2026-09-19

## Context

The original design treated hooks as the primary source and the transcript as a supplement for token counts.

Inspecting 27 real sessions on Claude Code 2.1.272 changed the picture. Subagent conversations are **not** sidechain entries inside the parent transcript — zero such entries exist. They are separate files:

```
~/.claude/projects/<slug>/<sessionId>/subagents/
├── agent-<agentId>.jsonl
└── agent-<agentId>.meta.json   # { agentType, description, toolUseId, spawnDepth, model }
```

and `meta.json.toolUseId` is exactly the `id` of the `Agent` tool-use block in the parent. The parent-child edge is recorded data.

## Decision

**The transcript reader is the source of truth and is built first.** Hooks provide low latency and the permission round-trip; they are not required for correctness.

## Rationale

- The entire board — agent tree, handoffs, tokens, timeline — is reconstructible from disk with no daemon running at the time the session happened.
- The reader is a pure function over files, so it is testable offline against recorded fixtures. A hooks-first design would make the test suite depend on a live session.
- If a hook is missed, dropped, or the daemon was down, the board still converges.

## Consequences

- Implementation order: contract → fixtures → transcript reader → daemon → hooks → installer → UI.
- The reader watches a **directory per session**, not a single file, and persists an offset per file.
- `subagents/` is an internal layout, not a documented interface. It is isolated behind a versioned adapter; `doctor` reports schema drift; the board degrades to hooks-only if the layout is unrecognized. Tracked as risk O3 in [docs/EVENT_MAP.md](../EVENT_MAP.md).
