# Event map

How each raw source field becomes a normalized `MiranteEvent`, and **where the documentation and the observed behavior disagree**.

Observed against **Claude Code 2.1.272** on Linux. Transcripts inspected: 27 sessions with subagent directories. Re-verify after a Claude Code upgrade; `mirante doctor` reports schema drift.

---

## 1. Hooks → events

Common payload fields on every hook: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`, `hook_event_name`, `effort.level`.

When a hook fires **inside a subagent**, the payload also carries `agent_id` and `agent_type`. These are present on `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `SubagentStart`, and `SubagentStop`.

| Hook event           | Normalized kind                     | Notes                                                                            |
| -------------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| `SessionStart`       | `session.started`                   | Opens the lane. `cwd` → `projectPath`.                                           |
| `SessionEnd`         | `session.ended`                     | **All `SessionEnd` hooks share a 1.5 s budget.** Must be fire-and-forget.        |
| `UserPromptSubmit`   | `prompt.submitted`                  | Starts a turn; main card → `thinking`. Timeout is reduced to 30 s on this event. |
| `SubagentStart`      | `agent.started`                     | Creates the subagent card.                                                       |
| `SubagentStop`       | `agent.finished`                    | Closes the card, writes the handoff line.                                        |
| `PreToolUse`         | `tool.started`                      | → `tool_running`. Carries `tool_name`, `tool_input`, `tool_use_id`.              |
| `PostToolUse`        | `tool.finished`                     |                                                                                  |
| `PostToolUseFailure` | `tool.failed`                       |                                                                                  |
| `PermissionRequest`  | `permission.requested`              | See §5 — which of this and `PreToolUse` drives approval is **unresolved**.       |
| `PermissionDenied`   | `permission.resolved`               | Fires when auto mode denies.                                                     |
| `Notification`       | `waiting.changed` → `waiting_input` | Claude is waiting on the human.                                                  |
| `PreCompact`         | `context.compacted`                 | Timeline marker; explains a context drop.                                        |
| `PostCompact`        | `context.compacted`                 | Carries the post-compaction size.                                                |
| `Stop`               | `waiting.changed` → `idle`          | Turn finished.                                                                   |
| `StopFailure`        | `error.raised`                      | Turn ended on an API error.                                                      |

### Hook transport

`type: "http"` is supported, with `url`, `headers`, `allowedEnvVars`, `timeout`, `statusMessage`. `allowedEnvVars` is required for `$MIRANTE_TOKEN` to expand inside `headers`. See [ADR-0003](adr/0003-http-hooks-over-command.md).

### Timeouts

Defaults: 600 s for `command`/`http`/`mcp_tool`. Reduced to 30 s on `UserPromptSubmit` / `PreModelSwitch` / `PostModelSwitch`, and 10 s on `MessageDisplay`. `SessionEnd` shares a 1.5 s budget across all hooks.

**Mirante always sets an explicit short timeout** rather than inheriting 600 s.

---

## 2. Transcript → events

### Main transcript

`~/.claude/projects/<project-slug>/<sessionId>.jsonl`

Per-entry fields: `uuid`, `parentUuid`, `type`, `timestamp`, `sessionId`, `cwd`, `gitBranch`, `version`, `userType`, **`entrypoint`**, `promptId`, `isSidechain`.

| Field                                         | Use                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `entrypoint`                                  | Distinguishes `claude-vscode` from the CLI. Satisfies the "terminal and VS Code in separate lanes" requirement directly. |
| `attributionSkill`                            | Active skill name on the entry. Used for the skill badge — no need to infer it from a `Skill` tool-use block.            |
| `attributionAgent`                            | Present on subagent entries.                                                                                             |
| `message.usage`                               | Token accounting. See §4.                                                                                                |
| `toolUseResult`                               | Structured tool result; the `Agent` variant is the handoff record. See §3.                                               |
| `sourceToolUseID` / `sourceToolAssistantUUID` | Links a result entry back to the tool-use block that produced it.                                                        |

Assistant content block types observed: `text`, `thinking`, `tool_use`.

### Subagent transcripts

```
~/.claude/projects/<project-slug>/<sessionId>/subagents/
├── agent-<agentId>.jsonl
├── agent-<agentId>.meta.json
└── workflows/<runId>/
```

`agent-<agentId>.meta.json`:

```json
{
  "agentType": "review-frontend",
  "description": "Revisar frontend export+tabela",
  "toolUseId": "toolu_01RTVpMZdve2xmgxXTYQrxxT",
  "spawnDepth": 1,
  "model": "sonnet"
}
```

Entries inside `agent-*.jsonl` carry `isSidechain: true` and `agentId`, and are otherwise shaped like main-transcript entries.

**`meta.json.toolUseId` equals the `id` of the `Agent` tool-use block in the parent transcript.** That pair is the handoff edge, `parentAgentId` included, with no heuristics.

---

## 3. The `Agent` tool result

The parent's `toolUseResult` for an `Agent` call:

```json
{
  "agentId": "a7f6778b447581a71",
  "status": "async_launched",
  "outputFile": "/tmp/claude-.../tasks/a7f6778b447581a71.output",
  "resolvedModel": "claude-sonnet-5",
  "description": "Revisar frontend export+tabela",
  "isAsync": true,
  "canReadOutputFile": true,
  "prompt": "..."
}
```

`status: "async_launched"` means the parent is **not blocked**. See §6.

Related result shapes observed: `{ resumedAgentId, success, message, pin }` for resumed agents, and `{ runId, workflowName, taskType, transcriptDir, status, summary, taskId }` for local workflows.

---

## 4. Token accounting

`message.usage` on assistant entries, observed shape:

```json
{
  "input_tokens": 2,
  "output_tokens": 464,
  "cache_creation_input_tokens": 41443,
  "cache_read_input_tokens": 27373,
  "output_tokens_details": { "thinking_tokens": 125 },
  "cache_creation": { "ephemeral_1h_input_tokens": 41443, "ephemeral_5m_input_tokens": 0 },
  "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
  "service_tier": "standard",
  "iterations": [{ "...": "per-iteration breakdown" }]
}
```

**`iterations[]` is a breakdown of the same totals, not additional usage. Summing it double-counts.** Only top-level fields are summed.

Session total = Σ top-level `message.usage` over assistant entries in the main transcript **plus** every `agent-*.jsonl` of that session. This is the definition used for M1 acceptance criterion 4.

---

## 5. Status line → events

Invoked with the session JSON on stdin. Debounced at 300 ms; **an in-flight script is cancelled** when a new update arrives.

| Field                                                   | Use                               |
| ------------------------------------------------------- | --------------------------------- |
| `context_window.used_percentage`, `.current_usage`      | Context occupancy in the top bar  |
| `cost.total_cost_usd`                                   | Session cost                      |
| `model.id`, `model.display_name`                        | Card header                       |
| `effort.level`, `thinking.enabled`, `fast_mode`         | Card metadata                     |
| `rate_limits.five_hour` / `.seven_day` / `.spend_limit` | Plan usage bars, with `resets_at` |
| `exceeds_200k_tokens`                                   | Context warning                   |
| `prompt_cache.hit_ratio`, `.warm`                       | Not used in M1                    |
| `agent.name`, `worktree`, `pr`, `session_name`          | Not used in M1                    |

**`rate_limits` availability:** only for Claude Pro and Max subscribers, only after the first API response of the session, never with an API key. Each window is independently optional and is **dropped once its `resets_at` passes**. The UI must treat absence as "unknown", never as zero.

The documentation describes **three** windows — `five_hour`, `seven_day`, and `spend_limit`. The original design assumed two.

---

## 6. Divergences from the briefing and open questions

| #      | Item                                                                                                                                                                                                                 | Status                                                                                                                                                                                             |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1     | Subagent turns were assumed to be `isSidechain` entries in the parent transcript, matched by `uuid`.                                                                                                                 | **Wrong for 2.1.272.** Zero `isSidechain:true` entries exist in any main transcript. They are separate files under `<sessionId>/subagents/`. Matching is by `meta.json.toolUseId`, which is exact. |
| D2     | Subagent identification in hooks was to be confirmed.                                                                                                                                                                | **Confirmed:** `agent_id` and `agent_type`. No fallback heuristic needed.                                                                                                                          |
| D3     | The parent was assumed to block on a subagent until it returns.                                                                                                                                                      | **Not generally true.** `status: "async_launched"` means the parent keeps working. `waiting_subagent` applies to synchronous calls only.                                                           |
| D4     | Skill detection was to come from the `Skill` tool-use block.                                                                                                                                                         | `attributionSkill` on the transcript entry is more direct and covers more cases.                                                                                                                   |
| D5     | `rate_limits` was assumed to have two windows.                                                                                                                                                                       | Three: `spend_limit` also exists.                                                                                                                                                                  |
| **O1** | **How a rate-limit error appears in the transcript — UNVALIDATED.** No rate-limit signature was found in any local transcript. M1 derives `rate_limited` **only** from status line percentage. Needs a real fixture. | **Open**                                                                                                                                                                                           |
| **O2** | **Whether `PreToolUse` or `PermissionRequest` is the correct hook to drive on-screen approval**, and whether both fire for the same call. Needs a recorded permission fixture.                                       | **Open**                                                                                                                                                                                           |
| **O3** | Whether the `subagents/` directory layout is stable across Claude Code releases. It is not a documented interface.                                                                                                   | **Open — mitigated by a versioned adapter.**                                                                                                                                                       |
