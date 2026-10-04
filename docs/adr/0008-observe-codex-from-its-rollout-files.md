# ADR-0008 — Observe OpenAI Codex from its rollout files

- **Status:** accepted
- **Date:** 2026-09-30

## Context

People run more than one coding agent. The same person who keeps Claude Code open in one terminal
runs OpenAI Codex — the coding agent behind ChatGPT — in the VS Code extension beside it, and wants
one board for both.

There are three ways Mirante could learn what Codex is doing:

1. **The OpenAI API or ChatGPT's servers.** Ruled out by [ADR-0005](0005-nothing-leaves-the-machine.md):
   it needs the network and a credential, and Mirante has neither. The ChatGPT web and desktop apps
   keep their conversations on OpenAI's servers, so they cannot be observed at all.
2. **Codex's `notify` hook or its app-server protocol.** Both exist, both would have to be
   configured in the person's `~/.codex/config.toml`, and neither carries the subagent tree.
3. **The rollout files Codex already writes.** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, one
   file per thread, appended as the thread works. Nothing to install, nothing to configure, and the
   same position ADR-0004 takes for Claude Code: the files on disk are the spine.

## Decision

**Mirante reads Codex rollout files, and nothing else of Codex's.** The reader opens only
`rollout-*.jsonl` under `$CODEX_HOME/sessions` (default `~/.codex/sessions`). It never opens
`~/.codex/auth.json`, `config.toml`, or any database beside them. No configuration of Codex is
written.

### What the files say, as observed on 0.154 and 0.155

Recorded into `tests/fixtures/codex-fanout` (0.154) and `tests/fixtures/codex-legacy` (0.155); the
mapping is in [EVENT_MAP.md §9](../EVENT_MAP.md).

- **Every thread names its root and its parent in its first line.** `session_meta.session_id` is the
  root thread's id in every file of a session; a subagent's `session_meta` carries
  `parent_thread_id`, `agent_role` and `agent_path` (`/root/<task_name>`). The handoff edge is
  recorded data, as it is for Claude Code.
- **A subagent's file opens by replaying its parent's history** — hundreds of lines, including the
  parent's own `session_meta`, prompts and turns. Read as the subagent's own, every subagent would
  claim to have typed the person's request. Its own work starts at the first `task_started` whose
  `turn_id` sorts at or after the thread's own id: both are UUIDv7, which are time-ordered. Checked
  against all 229 subagent files on the machine it was written on, with no exception. A naive
  timestamp rule fails on migrated files, where every line carries the same time.
- **Two record layouts report the same message**, chosen by Codex's `history_mode`, not by version:
  `event_msg` `user_message`/`agent_message` in `legacy`, `item_completed` `UserMessage`/`AgentMessage`
  in `paginated`. Both are read; a key built from the turn and the text collapses the pair.
- **Messages between agents are encrypted** (Fernet tokens, `gAAAA…`). There is no readable brief for
  a Codex subagent — only the task name its parent gave it. Encrypted text is never shown.
- **Subagents outlive their first task.** A Codex subagent goes quiet after `task_complete` and can be
  handed another with `followup_task`, which opens a new turn in the same file.
- **Guardian threads** (`source.subagent.other = "guardian"`) are Codex's automatic approval
  reviewer. They are not work anyone asked for and are not shown.
- **Skills have no event.** Codex uses a skill by reading its `SKILL.md`; a command that reads
  `…/skills/<name>/SKILL.md` is reported as that skill.
- **Files are large.** A long root thread runs to tens of megabytes (one on the recording machine
  is 165 MB), so the Claude Code watcher's approach — re-parse the whole session on every change —
  does not carry over.

## Consequences

### Contract

These are additions; no existing field changes meaning, and logs written before this ADR stay valid.

- **`harness` on the session** (`'claude-code' | 'codex'`), in `session.started` and on `SessionLane`,
  with `harnessVersion`. Absent means Claude Code. This is a property of the session, like
  `entrypoint` — _which coding agent runs it_ — and the interface names it. It is **not** `source`:
  `source` says how Mirante learned of an event (observer or, later, a driver), and ADR-0001's rule
  that the interface never branches on it is unchanged. An observed and a driven Codex session would
  share a harness and differ in source.
- **A new source, `codex-rollout`**, for auditing. It ranks with the transcript and never competes
  with another source for the same fact.
- **`agent.started` gains `followUp`.** A start that declares itself a new assignment may reopen a
  finished card, once, under its own dedupe key. Nothing else may: a late first report of an
  ordinary start — a transcript read after the hook saw the agent finish — still cannot bring an
  agent back to life.

### Behaviour

- The Codex watcher tails each file from a byte offset, reads a bounded number of bytes per pass so
  a first read of a large history never stalls the daemon, and skips the records it never uses —
  encrypted reasoning, the context Codex injects, inter-agent bookkeeping — by the head of the
  line, before parsing.
  Offsets are not persisted: a restart re-reads live files and skips what the log holds by
  signature.
- **Each harness keeps its own plan.** Codex writes its account's limits into every
  `token_count` record (`rate_limits`: windows sized in minutes, `plan_type`). They are read into
  `plan.usage.updated` with `harness: "codex"` — once per change, not once per report — and kept in
  `BoardState.harnessPlans`, apart from Claude Code's `planUsage`. Windows are named by size: 300
  minutes is the short window, 10,080 a week; any other size is left out rather than guessed. The
  top bar shows one block per account, each labelled, and draws only the windows a plan has. The
  rate-limit overlay holds each lane to its own harness's plan, and the automatic `/usage` reading
  of ADR-0007 runs while any observed agent is working, so switching to Codex does not disable
  the Claude meter's minute refresh. There is no "read now" for Codex: its figure is as
  fresh as its last answer, and the block says how old it is.
- A skill is in use for the request that invoked it, on both harnesses. The projector forgets a
  card's skill when a new prompt arrives, judged by origin time rather than arrival order.

### What this does not cover

The ChatGPT web and desktop apps. Their conversations live on OpenAI's servers; seeing them would
take a network call and a credential, which ADR-0005 rules out. Only Codex, which writes to disk,
can be observed.
