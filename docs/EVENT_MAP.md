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

Session IDs survive resumes. Observed on 2026-10-03: a conversation had three
`SessionEnd` events on earlier days, then new prompts and tools under the same
ID. A newer prompt, tool, assignment or resume reopens the lane and the agent
that resumed; other completed children stay closed. Each resume and close is a
separate lifecycle fact, including when replaying legacy dedupe keys. An older
close arriving after new execution cannot close that resumed work.

Reported `effort.level` on a hook or status line becomes
`agent.metadata.updated.effort`, scoped to the hook's `agent_id` or the main
agent for the status line. Assistant transcript entries also report a top-level
`effort` string: recorded fixtures contain `xhigh`, and live files inspected on
2026-10-03 contain `xhigh` and `max`. Codex reports the setting in its own
`turn_context.effort`; inherited parent contexts are excluded. Missing effort
in a new context becomes unknown. Settings carry no token usage and do not
restart a finished agent. The newest report wins per agent.

`type: "http"` is supported, with `url`, `headers`, `allowedEnvVars`, `timeout`, `statusMessage`. `allowedEnvVars` is required for `$MIRANTE_TOKEN` to expand inside `headers`. See [ADR-0003](adr/0003-http-hooks-over-command.md).

### Timeouts

Defaults: 600 s for `command`/`http`/`mcp_tool`. Reduced to 30 s on `UserPromptSubmit` / `PreModelSwitch` / `PostModelSwitch`, and 10 s on `MessageDisplay`. `SessionEnd` shares a 1.5 s budget across all hooks.

**Mirante always sets an explicit short timeout** rather than inheriting 600 s.

---

## 2. Transcript → events

### Main transcript

`~/.claude/projects/<project-slug>/<sessionId>.jsonl`

Per-entry fields: `uuid`, `parentUuid`, `type`, `timestamp`, `sessionId`, `cwd`, `gitBranch`, `version`, `userType`, **`entrypoint`**, `promptId`, `isSidechain`.

| Field                                         | Use                                                                                                                                                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entrypoint`                                  | Distinguishes `claude-vscode` from the CLI. Satisfies the "terminal and VS Code in separate lanes" requirement directly.                                                                                                    |
| `attributionSkill`                            | Active skill name on the entry. Used for the skill badge — no need to infer it from a `Skill` tool-use block.                                                                                                               |
| `attributionAgent`                            | Present on subagent entries.                                                                                                                                                                                                |
| `message.usage`                               | Token accounting. See §4.                                                                                                                                                                                                   |
| `toolUseResult`                               | Structured tool result; the `Agent` variant is the handoff record. See §3.                                                                                                                                                  |
| `sourceToolUseID` / `sourceToolAssistantUUID` | Links a result entry back to the tool-use block that produced it.                                                                                                                                                           |
| `message.content[].text`                      | What the agent wrote between its tool calls → `agent.said`. One event per passage, keyed by the entry `uuid` plus the block index, truncated to 400 characters and scrubbed at ingest.                                      |
| `toolUseResult.prompt` (`Agent` calls)        | The brief the parent wrote → `agent.started.brief`, kept to 700 characters with its paragraphs, plus `briefCharCount` so the card can say how much it is not showing. Also present as the tool-use `input.prompt`. See D13. |

Assistant content block types observed: `text`, `thinking`, `tool_use`. The
`thinking` block is present but **empty**: it carries `thinking: ""` and a
`signature` of roughly a kilobyte. The reasoning a terminal displays is streamed
live and never written to disk, so no reader of transcripts can recover it. See
D12.

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

## 6a. Approval: which hook, and what it must return

Resolved against the documentation, and the answer shaped the design.

**`PreToolUse` fires before every tool call**, whether or not it needs permission.
**`PermissionRequest` fires only when Claude Code is about to ask.** Both can fire for
the same call, in that order. Gating on `PreToolUse` would therefore add the approval
window to _every_ tool call, so Mirante treats it as ingest only and answers immediately.

`PermissionRequest` receives `tool_name` and `tool_input` **but no `tool_use_id`**, plus an
optional `permission_suggestions` array. Mirante mints its own request id.

The response is a `decision` object — not `permissionDecision`:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" }
  }
}
```

`behavior` is `"allow"` or `"deny"`; `message` explains a deny; `updatedInput` and
`updatedPermissions` apply to allow only. **There is no `"ask"`.** Exit code 2 is not
honoured for this event.

This makes the fallback safe by construction: returning **no decision object** leaves
Claude Code's permission flow untouched and the terminal asks. A hook that times out has
its output discarded and lands in exactly the same place. Nothing has to be held open.

One consequence worth knowing: in sessions that cannot show a prompt — background
subagents in non-interactive mode — Claude Code denies the call if no hook returns a
decision. Mirante turns that into an opportunity rather than a risk: the request appears
on the board, and a click can allow something that would otherwise have been auto-denied.

---

## 6. Divergences from the briefing and open questions

| #      | Item                                                                                                                                                                                  | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1     | Subagent turns were assumed to be `isSidechain` entries in the parent transcript, matched by `uuid`.                                                                                  | **Wrong for 2.1.272.** Zero `isSidechain:true` entries exist in any main transcript. They are separate files under `<sessionId>/subagents/`. Matching is by `meta.json.toolUseId`, which is exact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D2     | Subagent identification in hooks was to be confirmed.                                                                                                                                 | **Confirmed:** `agent_id` and `agent_type`. No fallback heuristic needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D3     | The parent was assumed to block on a subagent until it returns.                                                                                                                       | **Not generally true.** `status: "async_launched"` means the parent keeps working. `waiting_subagent` applies to synchronous calls only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D4     | Skill detection was to come from the `Skill` tool-use block.                                                                                                                          | `attributionSkill` on the transcript entry is more direct and covers more cases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D5     | `rate_limits` was assumed to have two windows.                                                                                                                                        | Three: `spend_limit` also exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D6     | The first line of a transcript was assumed to describe the session.                                                                                                                   | **Wrong.** Every session on disk opens with bookkeeping records — `bridge-session`, `queue-operation`, `mode`, `ai-title`, `file-history-snapshot` — carrying no `cwd`, no `entrypoint` and often no `timestamp`. Session identity is taken from the first `user` or `assistant` entry instead. This surfaced only against live data: a fixture recorded mid-session has no preamble.                                                                                                                                                                                                                                                                                                                                                                                   |
| D7     | `attributionSkill` was assumed to hold for the duration of a skill.                                                                                                                   | It is absent on entries the skill does not cover, so it flickers between a name and nothing. Tracking the last _named_ skill, rather than the last value, keeps one timeline row per invocation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D8     | Approval was assumed to run through `PreToolUse` with a `permissionDecision` of allow/deny/ask.                                                                                       | **Wrong on all three points.** See §6a: the gate is `PermissionRequest`, the field is `decision.behavior`, and there is no `ask`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D9     | Plan limits were believed to be reachable only through the status line, and therefore only from a terminal.                                                                           | **Wrong.** `/usage` is a local command — no tokens, no model call — and works in print mode from anywhere. See §7. The terminal-only constraint applies to the _push_ surface, not to the data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D10    | `StopFailure` was read for a `message` field, like `Notification`.                                                                                                                    | **Wrong.** Its fields are `error` (e.g. `rate_limit`), `error_details` and `last_assistant_message`. There is no `message`, so all five failures on record arrived as "Turn ended with an error" — one of them a subagent stopped by the 5-hour limit. The hook now reads the real fields, and the transcript's `quotaLimits` supplies the window and reset time (§8).                                                                                                                                                                                                                                                                                                                                                                                                  |
| D11    | A subagent's end was taken from the `SubagentStop` hook, with the transcript's final assistant `end_turn` as the fallback.                                                            | **Both fail in practice.** The hook says `ok` for every agent, the failed ones included, and is lost when the daemon is not listening. The fallback never fires for current subagents, which hand back through a tool and end their file on an `attachment`. The authoritative signal is the parent's `<task-notification>` — an `attachment` entry, `attachment.commandMode: "task-notification"`, whose `prompt` holds `<task-id>` and `<status>` (`completed`, `failed`, `killed`). That entry has **no `sessionId` and no `cwd`**; identity comes from the session. Observed: an Explore agent shown as running for 12 hours after it finished.                                                                                                                     |
| D12    | The board showed only what agents did, on the assumption that their prose and their thinking were equally out of reach.                                                               | **Half wrong.** The prose is on disk: `text` blocks in the assistant entries, 366 of them in one 34 MiB session, 345 characters on average. They are now read as `agent.said`, so a card can say what the agent is doing in its own words instead of naming a command. The thinking is genuinely out of reach: its block is written with an empty `thinking` field and a signature only.                                                                                                                                                                                                                                                                                                                                                                                |
| D13    | The instruction a parent writes for a subagent was assumed to be reachable, if at all, through the subagent's own first entry.                                                        | **It is recorded three times and Mirante kept none of them.** `Agent` tool-use `input.prompt`, the result's `toolUseResult.prompt`, and the subagent transcript's first entry are byte-identical; measured at 2,955–4,956 characters across 8 calls in one session, against the 30–47 characters of `description` that the board did keep. Worse, the subagent's copy carries the **parent turn's** `promptId`, and `dedupeKeys.promptSubmitted` has no agentId in it, so every brief collided with the human request of that turn and with its sibling briefs: 1 of 8 reached the log, and the projector discarded that one. The brief now travels on `agent.started` (`brief`, `briefCharCount`), and a sidechain entry with no parent is no longer read as a prompt. |
| D14    | D4 took `attributionSkill` as the source for skills, on the assumption that it covers every skill.                                                                                    | **Not for the `Skill` tool on 2.1.27x.** A skill loaded by the model through the `Skill` tool leaves no `attributionSkill` on the entries after it — observed in the session that built this change, where the result entry carries only `toolUseResult.commandName`. The tool-use block's `input.skill` is now read as well; tracking the last named skill keeps a later attribution of the same skill from reporting it twice. A skill is in use for the request that invoked it: the card forgets it on the next prompt, by origin time.                                                                                                                                                                                                                             |
| **O1** | **How a rate-limit error appears in the transcript.** Found: `quotaLimits`, with a machine-readable `resetsAt`. 70 entries across 14 distinct 5-hour windows on this machine. See §8. | **Resolved — see §8.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **O2** | Which hook drives on-screen approval, and what it must return.                                                                                                                        | **Resolved — see §6a.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **O3** | Whether the `subagents/` directory layout is stable across Claude Code releases. It is not a documented interface.                                                                    | **Open — mitigated by a versioned adapter and reported by `mirante doctor`.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

---

## 7. Plan limits without the status line

The status line is the only surface that **pushes** plan limits, and it runs only in the
interactive terminal UI. Two surfaces can be **pulled**, from anywhere.

### 7a. `cachedUsageUtilization` in `~/.claude.json` — the cheap one

Claude Code stores the figure it last fetched. **It writes it when `/usage` runs, not as it works** — measured: two writes within seconds of two `/usage` runs, then none for 171 minutes of ordinary work. Structured,
free, instant, and no subprocess:

```
$.cachedUsageUtilization.fetchedAtMs                        ms epoch — when Claude Code fetched it
$.cachedUsageUtilization.utilization.five_hour.utilization  0–100 (whole percent, NOT a fraction)
$.cachedUsageUtilization.utilization.five_hour.resets_at    ISO 8601 string (NOT epoch seconds)
$.cachedUsageUtilization.utilization.seven_day.{utilization,resets_at}
$.cachedUsageUtilization.utilization.seven_day_breakdown.rows[]   {key, display_name, percent}
```

**Units differ from the status line.** There, `used_percentage` is already 0–100 but
`resets_at` is **epoch seconds**. Here `resets_at` is an **ISO string**. Do not mix them.

`seven_day_breakdown.rows` is the direct evidence that the percentage is **per account and
across surfaces** — observed here as Claude Code 91%, Chats 8%, Cowork 1%. No local token
sum can ever reproduce it.

Mirante takes **only** `five_hour` and `seven_day` from this file. It also holds the
account's email and identifiers, which the schema excludes by construction — see ADR-0006.

A reading older than one hour is refused rather than shown.

### 7b. `/usage` in print mode — the fallback

Run as `claude -p "/usage" --output-format json`, the response envelope reports:

| Field             | Observed | Meaning                                             |
| ----------------- | -------- | --------------------------------------------------- |
| `local_command`   | `usage`  | Handled locally. The adapter refuses anything else. |
| `total_cost_usd`  | `0`      | Spends nothing                                      |
| `duration_api_ms` | `0`      | No model call                                       |
| `num_turns`       | `0`      | No turn was taken                                   |
| `result`          | prose    | The report, as printed                              |

The report itself:

```
You are currently using your subscription to power your Claude Code usage

Current session: 67% used · resets Sep 20, 10pm (America/Sao_Paulo)
Current week (all models): 57% used · resets Sep 24, 5am (America/Sao_Paulo)
```

`Current session` maps to `fiveHour`, `Current week (all models)` to `sevenDay`. Any other
`Current …: N% used` line is reported as drift rather than dropped.

**Cross-checked against the status line.** The two surfaces were sampled within the same
hour and agree exactly: `Sep 20, 10pm (America/Sao_Paulo)` resolves to `1789952400`, and
`Sep 24, 5am` to `1790236800` — the two `resets_at` values `rate_limits` reported
independently. A test asserts this, so a change to either surface breaks the build rather
than the board.

The printed time carries **no year**, so it is inferred as the nearest reset at or after
now, which is what makes a December-to-January reset resolve forwards.

**The probe must not feed itself, and it takes two guards.** Invoking `claude` fires
Mirante's hooks — observed five times during validation — _and_ writes a transcript.
`--setting-sources project`, from a directory belonging to no project, loads none of the
user's settings and fires no hook; but the transcript is written regardless, and the
watcher read it back as a session the user never opened. The probe's project directory is
therefore also excluded from the watcher by slug.

`--bare` does **not** work here: it forces `ANTHROPIC_API_KEY` or `apiKeyHelper` and never
reads OAuth, so it fails for exactly the subscribers this feature is for.

See [ADR-0006](adr/0006-plan-limits-on-demand.md) for why this is on demand only.

---

## 8. Hitting the limit → the transcript says so

When a request is refused for quota, Claude Code writes a synthetic assistant entry. Both
a structured object and prose:

```
$.type                     === "assistant"
$.isApiErrorMessage        === true
$.error                    === "rate_limit"
$.apiErrorStatus           === 429
$.message.model            === "<synthetic>"          locally generated, always zero tokens
$.message.content[0].text  === "You've hit your session limit · resets 10pm (America/Sao_Paulo)"

$.quotaLimits.status                             "rejected"
$.quotaLimits.resetsAt                           UNIX EPOCH SECONDS
$.quotaLimits.rateLimitType                      "five_hour"   (all 70 observed)
$.quotaLimits.unifiedRateLimitFallbackAvailable  bool
$.quotaLimits.isUsingOverage                     bool
```

Measured on this machine: **70 such entries across 14 distinct windows**, in both main
transcripts and `subagents/agent-*.jsonl` — a subagent logs its own refusal, so counting
raw entries overcounts. Dedupe on `quotaLimits.resetsAt`.

This is what closes O1. The parser turns such an entry into `error.raised` with
`kind: "rate_limit"` and `limit: { window, resetsAt }`, and the card says "Stopped at the
5-hour limit — reopens at 22:00" instead of a generic error. The transcript says outright
that a request was refused, and says when the window reopens.

**Not available:** there is no "approaching the limit" record. `status: "allowed_warning"`
exists in Claude Code's own memory but is never written to a transcript or to disk, so a
warning ahead of the ceiling can only come from a percentage.

---

## 9. OpenAI Codex rollouts → events

Decided in [ADR-0008](adr/0008-observe-codex-from-its-rollout-files.md). Observed on Codex
0.154 and 0.155 (VS Code extension), recorded into `tests/fixtures/codex-fanout` and
`tests/fixtures/codex-legacy` with `pnpm fixture:codex`.

Files live at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<threadId>.jsonl`, one per
thread, in the directory of the day the thread started. Each line is
`{ timestamp, [ordinal], type, payload }`. Only these files are read; `auth.json` beside them
never is.

### Identity

| Codex                                                      | Mirante                                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `session_meta.session_id` (the root's id, in every thread) | `sessionId` — one lane per root thread                                     |
| root thread                                                | `agentId: "main"`                                                          |
| subagent `session_meta.id`                                 | `agentId`                                                                  |
| `parent_thread_id` (or `source.subagent.thread_spawn`)     | `parentAgentId` — `main` when the parent is the root                       |
| `agent_role`                                               | `agentType`                                                                |
| last segment of `agent_path` (`/root/<task_name>`)         | `agent.started.description`                                                |
| `source` / `originator` (`vscode`, `cli`, `exec`)          | `entrypoint` (`vscode`, `cli`, `print`)                                    |
| `cli_version`                                              | `session.started.harnessVersion`, `harness: "codex"`                       |
| `git.branch`, `cwd`, `turn_context.cwd`                    | `gitBranch`, `projectPath`                                                 |
| `task_started.root_turn_id` (falls back to `turn_id`)      | `promptId` — a subagent's work is attributed to the request that caused it |
| `source.subagent.other: "guardian"`                        | ignored — Codex's approval reviewer, not work                              |

### Records

| Record                                                                           | Event                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| root `session_meta`                                                              | `session.started`                                                                                                                                                                                       |
| `event_msg/task_started` — root                                                  | `waiting.changed` → `thinking` (a turn can start without a prompt: a subagent's reply wakes the root)                                                                                                   |
| `event_msg/task_started` — subagent, first                                       | `agent.started` (`spawnMode: async`), key `agent.started:<id>`                                                                                                                                          |
| `event_msg/task_started` — subagent, later                                       | `agent.started` with `followUp: true`, key `agent.started:<id>:<turn>`                                                                                                                                  |
| `event_msg/task_complete` / `turn_aborted` — root                                | `waiting.changed` → `idle`                                                                                                                                                                              |
| `event_msg/task_complete` / `turn_aborted` — subagent                            | `agent.finished` (`ok` / `interrupted`), key `agent.finished:<id>:<turn>`                                                                                                                               |
| `event_msg/user_message` (legacy) · `item_completed` `UserMessage` (paginated)   | `prompt.submitted` — root only; key from the turn and the text, so the two layouts collapse                                                                                                             |
| `event_msg/agent_message` (legacy) · `item_completed` `AgentMessage` (paginated) | `agent.said`                                                                                                                                                                                            |
| `response_item/custom_tool_call` `exec` (a script) · `function_call`             | `tool.started`; tool named in the board's vocabulary (`exec_command` → `Bash`, `apply_patch` → `Edit`, `view_image` → `Read`, `web__run` → `WebSearch`); summary is the first `cmd`                     |
| `…_output` for an open call                                                      | `tool.finished`, or `tool.failed` when it opens with `Script failed` / `collab tool failed`                                                                                                             |
| a call reading `…/skills/<name>/SKILL.md`                                        | `skill.invoked` — Codex has no skill event; reading the file is how a skill is used                                                                                                                     |
| `function_call` `collaboration/wait_agent`                                       | `waiting.changed` → `waiting_subagent`, naming the roles this thread spawned, or "other agents"                                                                                                         |
| `function_call` `request_user_input`                                             | `waiting.changed` → `waiting_input` with the question; its output clears it                                                                                                                             |
| `token_usage_record` (own `thread_id` only)                                      | `usage.updated` (agent); `input` excludes `cached_input_tokens`, which becomes `cacheRead`                                                                                                              |
| `event_msg/token_count` — root                                                   | `usage.updated` (session) with context %, only when the whole percentage changes                                                                                                                        |
| `event_msg/token_count` `rate_limits` — any thread                               | `plan.usage.updated` with `harness: "codex"` and `planType`, when the reading changes or once per minute to confirm freshness; windows named by `window_minutes` (300 → `fiveHour`, 10080 → `sevenDay`) |
| `event_msg/context_compacted`                                                    | `context.compacted`                                                                                                                                                                                     |

### Divergences

| #   | Assumption                                                             | Observed                                                                                                                                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | A subagent's file holds the subagent's work.                           | **It opens by replaying its parent's history**, parent `session_meta` and prompts included. Own work starts at the first `task_started` whose `turn_id` (UUIDv7) sorts at or after the thread's id. Held for all 229 subagent files on the recording machine. A timestamp rule fails on migrated files, where every line has one time.                  |
| C2  | A version of Codex writes one layout.                                  | **The layout follows `history_mode`**, not the version: `legacy` writes `event_msg` messages, `paginated` writes `item_completed` items. 0.155 wrote both kinds of session.                                                                                                                                                                             |
| C3  | A subagent's instruction would be readable, as a Claude Code brief is. | **Encrypted.** `spawn_agent`, `send_message` and `followup_task` carry `message` as a Fernet token (`gAAAA…`). Only `task_name` and `agent_type` are readable. Nothing encrypted is shown.                                                                                                                                                              |
| C4  | A subagent finishes once.                                              | **It can be handed more work** (`followup_task`), which opens a new turn in the same file. Hence `followUp`.                                                                                                                                                                                                                                            |
| C5  | `request_user_input_async` waits on the person.                        | **It returns `{"accepted": true}` at once** and the agent keeps working; the question is echoed as the agent's own message. Only the synchronous form is a wait.                                                                                                                                                                                        |
| C6  | Files are small enough to re-read, as Claude Code transcripts are.     | **Up to 165 MB.** Tailed from a byte offset instead, a bounded amount per pass, with encrypted reasoning, injected context and inter-agent bookkeeping skipped by the head of the line before parsing. Measured: 40 MB of live rollouts read in 0.4 s.                                                                                                  |
| C7  | Codex's limits could share the plan meters.                            | **Different account, different windows.** Kept in `harnessPlans.codex`, never in `planUsage`. Windows are sized, not named: the `plus` plan wrote 300 and 10,080 minutes, `prolite` a week alone. On disk: 4,283 readings of a 300-minute window, 41,311 of a week; `rate_limit_reached_type` never set, and `used_percent` reaching 100 on 2026-09-18. |
