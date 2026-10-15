# Mirante

**Local lookout for coding agents. See every agent, what it's doing, what it's waiting on, and what it costs.**

A _mirante_ is the high point you climb to take in the whole valley at once — the overlook. That is the job of this project. When a Claude Code session starts spawning subagents, visibility collapses: you cannot see who is running, what each one is doing right now, how many tokens each has burned, who finished and handed work back to whom, and — the part that actually costs you time — what is sitting still, waiting for something.

Mirante is a local, browser-based board that answers those questions while you keep working in your terminal or in the VS Code extension.

> **Not a log feed and not a cost chart.** It is a board of cards, one per agent, each with an icon, an explicit state, its current activity, its token usage, and a timeline of handoffs between agents.

---

## Status

**Pre-release — M1 feature-complete.** Published on npm as [`mirante`](https://www.npmjs.com/package/mirante); see [Install](#install). Expect rough edges and breaking changes between alphas. See the [roadmap](#roadmap).

**Release version: `0.1.0-alpha.3`.** This version adds live progress from recorded
Markdown checklists, including updates through terminal commands, and preserves
plan progress when subagents report back. Shared checklists keep each agent's
progress distinct. It also includes the refreshed theme
and activity effects, canvas zoom and dragging, persistent agent filters,
individual card positioning, agent recovery controls, corrected token and cost
updates, instruction capture repairs, and local English/Portuguese translation.
It also includes the compact agent map, recorded plan progress with individual
circles, and expandable recorded agent responses.
Translation models require a separate one-time setup. See
[Releasing](docs/RELEASING.md) for how a validated source build becomes an npm release.

---

## How it works

Mirante **observes by default**. It does not start agents automatically or replace your terminal workflow. You can explicitly verify or resume an interrupted agent from its session's recovery controls.

You keep starting sessions exactly as you do today — `claude` in a terminal, the VS Code extension, `claude -p` in a script. Mirante installs a set of hooks and a status line, reads the session transcripts Claude Code already writes to disk, and renders everything on a live board.

**OpenAI Codex too.** If you also run Codex — the coding agent behind ChatGPT, in the terminal or the VS Code extension — its sessions appear on the same board, each labelled with the agent that runs it, a filter shows either one on its own, and Codex's plan limits sit beside Claude Code's in the top bar. Mirante reads the rollout files Codex already writes under `~/.codex/sessions` (or `$CODEX_HOME`), and nothing else: no Codex setting is touched, `auth.json` is never opened, nothing is sent to OpenAI. The ChatGPT web and desktop apps keep their conversations on OpenAI's servers and cannot be observed without the network, which Mirante does not use. See [ADR-0008](docs/adr/0008-observe-codex-from-its-rollout-files.md).

```
   Claude Code sessions                  mirantd (127.0.0.1)              Board
   ────────────────────                  ───────────────────              ─────
   terminal ─┐
   VS Code  ─┼── hooks (HTTP) ─────────▶ ingest ─┐
   claude -p ┘                                   ├─▶ normalized events ─▶ SQLite ─▶ WebSocket ─▶ UI
             └── transcript JSONL ─────▶ tail ───┤
             └── status line ──────────▶ push ───┤
   ~/.claude.json (cached plan figure) ─▶ read ───┘
```

The board folds one normalized event contract.

The top-right total updates as native token and cost readings arrive, including
small increments. Tokens count each response once, even when Claude writes
several partial blocks. Claude's cumulative cost can also be read from its
transcript without a status line. Open the total to see measurement dates and
how many observed sessions reported cost; sessions without a monetary reading
are excluded from that amount, not treated as free. These are recorded session
costs, not a subscription balance or a price estimate.

The board shows a radial agent tree inside each session with children, with the
main agent at the center; expand it to follow nested delegations or open an
agent's activity. Working cards stay lit and inactive cards turn neutral. Hide
inactive, interrupted, waiting and completed agents with **Working only**, or
select **All** to show them again without moving the remaining cards. The main
agent and ancestors of working branches remain as context. This preference
is shared by the compact maps and session detail and survives a reload. The center control
returns to the main agent after scrolling. Working projects retain a lit frame
in the project filter row.

Preventive allowance alerts appear at 80% and 90% usage, using readings no older
than five minutes. You can dismiss the current notice with its close button;
a different severity or allowance window shows a new notice. They offer a local recovery export and an instruction for
the coordinator to save a summary and wait for permission to continue. These
are advisory margins, not a completion forecast or paid-credit balance.
Observer mode cannot pause agents or guarantee that credits remain for a summary.

### Map navigation and agent recovery

Drag the canvas background to pan, or hold Space and drag over a card. Ordinary
card clicks still open the agent's activity. Drag a card to reposition that agent;
its connections follow and its position is remembered locally for the session,
including when inactive agents are hidden. Focus a card and use Alt + arrow keys
to move it with the keyboard (Shift takes larger steps). **Restore positions**
returns to the automatic radial layout. The canvas supports zoom buttons,
Ctrl/Cmd + mouse wheel, two-finger pinch,
and **Fit map** to show every visible branch. Focus the canvas to use `+`, `-`,
`0` (100%), or `F` (fit). Ordinary scrolling remains available.

The session view offers **Agent map** beside the canvas controls: a compact
hierarchy for quickly opening an agent's actual received instruction, model,
state, execution duration and individual token count. The prompt opens expanded,
with the same local translation and original-text controls as the activity view.
**Back to map** preserves the map's scroll position; **Open full activity** moves
to that agent's history. The map shares the working-only filter with the canvas
and supports collapsible branches, keyboard navigation and small screens.

**Plan progress** appears above the agent tree and the selected agent's activity.
A small circle beside each agent shows that agent's own checklist percentage,
updated as completed steps arrive. Expand **View steps** to read the plan and
its current stage. Codex `update_plan`, Claude `TodoWrite`, and native task lists
are captured only after successful results. Claude can also save a Markdown plan
inside the project: use a plan/progress filename and heading, with `- [ ]` and
`- [x]` checklist items. A successful `Write` or `Edit` registers that file;
Mirante then follows updates to the same file while the assignment is active.
Expanded steps show the source filename. This reads only the registered plan,
without scanning other project files or interpreting percentages written in prose.
Completed steps have equal weight; working steps, elapsed time, tokens, and a
session close do not imply completion.
Missing, empty or partial plans have no numeric percentage. A shared list with
tasks owned by another agent remains partial for a subagent. New/reopened steps
can lower it, and a new assignment clears the previous plan. Parent and child
checklists are kept separate. When an agent explicitly reuses a previously
recorded checklist file in a later request, Mirante reads that file again for
the new request; an unrelated request does not inherit its percentage.

Return rows in the activity show the agent's recorded response. Short replies
are readable inline; **Read response** expands long replies while preserving
paragraphs and code as plain text. Missing, encrypted, and truncated responses
are labelled. Supported native finish records retain up to 64K characters after secret
redaction. Existing known finishes can be enriched from their original local
transcripts without restarting the agent or asserting a new completion.

**Review agents** distinguishes interrupted tasks and unconfirmed endings from
explicit completion. **Verify** uses the installed CLI in read-only mode to
inspect the original task and return a report. **Resume** first checks the task,
then continues any remaining authorized work. Both consume your account's
allowance and run only after a button click. Claude Code recoveries resume the
original coordinator and address its child by ID, one at a time per session;
Codex recoveries resume the original thread. Missing transcripts, permissions,
unsupported IDs, or unavailable children are reported as blockers or unknown
results. They are never represented as successful completion.

Bulk controls queue pending agents. **Stop** cancels queued jobs or stops only
CLI process groups created by this panel; it cannot stop a session in another
terminal. Recovery acknowledgements and reports are stored separately from
observed task outcomes. Refreshing or restarting Mirante never resumes work
automatically; a recovery without an exit acknowledgement remains unknown.

This is a limited CLI recovery adapter. The full SDK driver described in
[V2_DRIVER.md](docs/V2_DRIVER.md) remains planned.

An agent’s activity shows the instruction it received and subsequent messages
between agents, with sender and recipient identities when the files record them.
**Read the instruction** expands the redacted body, preserving paragraphs and
indentation; unusually large instructions have an explicit 64K-character limit.
Claude Code assignments are recovered from the parent call/result or the child’s
initial message. Codex’s plaintext delivered messages can supply the instruction
even when the original call argument is encrypted. At startup, Mirante also
repairs instructions for sessions already on the board, including older files,
without importing unrelated old sessions or restarting finished work. Missing or
encrypted-only records receive a specific explanation; absent text is never invented.

Instructions follow the panel's English/Portuguese preference through local
automatic translation. **View original** preserves access to the recorded
instruction; code, commands, paths, URLs and paragraph boundaries stay intact.
Only visible instructions are translated, in a separate CPU worker, and neither
the original event nor agent execution is changed. Ambiguous language is kept
as recorded. Translation failures explain why the original is being shown.

Translation requires a separate one-time model setup; see
[Local instruction translation](#local-instruction-translation).

The normalized event sources are:

| Source                 | Role                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Hooks**              | Primary real-time signal. Push, low latency.                                                                                                                                   |
| **Transcript JSONL**   | Source of truth for content, token usage, the agent tree, what each agent says in its own words, when a subagent ends and why, and when a request was refused at a plan limit. |
| **Status line**        | Plan usage pushed while a terminal session is open.                                                                                                                            |
| **`/usage`**           | Plan usage anywhere, including the VS Code extension. Run once a minute while an agent is working, and by "Read now": a local command that spends no tokens.                   |
| **Cached plan figure** | The 5-hour and weekly figures `/usage` leaves in `~/.claude.json`. Read for free; only those two numbers are taken.                                                            |
| **OpenTelemetry**      | Optional second source for tokens and cost. Planned for M2.                                                                                                                    |

Every source is normalized into the same append-only event stream before it reaches the UI. Nothing raw from a hook or a transcript is ever sent to the front end.

## Install

Mirante is published on npm as [`mirante`](https://www.npmjs.com/package/mirante).

**You need:** Node.js **22.13 or newer** (with npm/npx), and local sessions from
Claude Code or Codex. Claude Code hooks are optional for Codex-only use: Codex
is observed from its local rollout files, without modifying its settings.

### Run with npx

No global install or repository clone is needed. `npx` downloads the package
and dependencies into npm's cache. For Claude Code, run `install` once to connect
its hooks and status line, then start the board:

```bash
npx mirante@latest install
npx mirante@latest
```

Mirante uses CPU inference. Before the first npm/npx installation, you can skip
unused GPU binary downloads with `export ONNXRUNTIME_NODE_INSTALL_CUDA=skip`
in Bash/zsh, or `$env:ONNXRUNTIME_NODE_INSTALL_CUDA = 'skip'` in PowerShell.

For **Codex only**, just run `npx mirante@latest`; the Claude Code installation
step is not required.

Open the complete URL printed in the terminal, including `?token=…`. The default
address is `http://127.0.0.1:7788`, but opening that address alone in a new browser
tab does not authenticate it. Keep the terminal running while using the panel;
Ctrl+C stops Mirante. Each person sees the sessions on their own computer.

### Or install it globally

```bash
npm install -g mirante@latest
mirante install
mirante
```

A global install puts `mirante` on your `PATH`, which is handier for `stop`, `doctor` and `purge`, and avoids re-downloading the package whenever the `npx` cache is cleared. Nothing `install` writes into your Claude Code settings points into that cache, so both routes behave the same.

Then use Claude Code or Codex the way you always do. The board fills itself.

> **Native module.** Mirante keeps its event log in `better-sqlite3`, which has a native part. npm downloads a prebuilt binary where one exists; otherwise it compiles one, which needs a C++ toolchain (`build-essential` on Debian and Ubuntu, the Xcode command line tools on macOS). That download is npm installing the package. Mirante itself makes no outbound call.

### Check it, update it, remove it

```bash
mirante doctor                  # are hooks firing, is the status line reporting, are transcripts read?
npm install -g mirante@latest   # npx users: run npx mirante@latest instead
mirante install                 # safe to re-run after an update
```

To remove it completely, undo the settings first, then the package:

```bash
mirante uninstall               # reverses exactly what install wrote
mirante purge --yes             # optional: deletes everything Mirante stored
npm uninstall -g mirante        # only if you installed it globally
```

`install` writes only inside a demarcated block, backs up every file it touches with a timestamp, merges without destroying hooks or a status line you already had, and prints exactly what changed. `uninstall` reverses precisely that block and restores your previous status line.

## Run from source

For contributors, or to try a commit that is not released yet. Requires Node 22.13+ and pnpm.

```bash
git clone https://github.com/christianfelipecarvalho/mirante.git
cd mirante
pnpm install
pnpm build

node packages/cli/dist/bin.js install   # for Claude Code; optional for Codex-only use
node packages/cli/dist/bin.js           # starts the daemon, prints the board URL
```

`pnpm daemon` rebuilds both the server and the board before starting on port
7788, including changes to the agent tree. For live code updates, `pnpm dev`
runs the board with hot reload on port 7789 and the API on port 7788.

Try it against a throwaway configuration first — `MIRANTE_HOME` and `--settings` keep it
entirely out of your real setup:

```bash
MIRANTE_HOME=/tmp/mirante-try node packages/cli/dist/bin.js install \
  --settings /tmp/mirante-try/settings.json --port 7799
```

`mirante doctor` tells you whether hooks are firing, the status line is reporting, and
transcripts are being read — the three things that have to be true for the board to fill.

### Local instruction translation

Local translation is included from `0.1.0-alpha.1`. Installing the board alone
does not install the models.

From a source checkout containing the feature:

```bash
pnpm translation:setup
```

For a global npm installation, on Linux or macOS:

```bash
node "$(npm root -g)/mirante/dist/setup-translations.mjs"
```

Or in PowerShell:

```powershell
node (Join-Path (npm root -g) 'mirante/dist/setup-translations.mjs')
```

Setup downloads about 228 MiB of pinned EN/PT models from Hugging Face once.
Translation then works offline; the dashboard does not download models or send
instruction text to a provider. The default directory is
`~/.mirante/translations/models`, respecting `MIRANTE_HOME`;
`MIRANTE_TRANSLATION_MODEL_DIR` selects another local directory.
Node inference uses CPU binaries already shipped by ONNX Runtime. For plain npm
installation of a translation-enabled package, set
`ONNXRUNTIME_NODE_INSTALL_CUDA=skip` to skip unused GPU binaries.

### Interface design tools

The project includes [Impeccable](https://github.com/pbakaus/impeccable) in
`.agents/skills/impeccable`. Codex discovers this project-local skill on the next
turn; use `$impeccable` for interface reviews and refinements. [AGENTS.md](AGENTS.md)
records how to apply it to Mirante's existing design.

To review the frontend with its mechanical detector:

```bash
sh .agents/skills/impeccable/scripts/impeccable detect --json apps/web/src
```

The launcher downloads and verifies its pinned engine once if it is not cached.
That is developer tooling; the Mirante application remains local and offline.
Automatic editor hooks are optional and are not enabled by this setup.

## Privacy and safety

These are hard rules, not defaults:

- **Mirante never reads, stores, or transmits a credential.** It does not touch Claude Code credential files, has no login of its own, and never calls `api.anthropic.com`.
- **The Mirante daemon makes no outbound network calls.** No telemetry, Mirante account, or remote dashboard server. Observation stays local. Explicit Verify/Resume actions invoke your installed Claude Code or Codex CLI, which uses its own account and contacts its provider. Mirante does not read its credentials.
- **The daemon binds to `127.0.0.1` only**, requires a token generated at install time, and validates the `Origin` header.
- **Prompts, tool inputs, and what the agents write back can contain secrets.** They are stored locally, truncated and scrubbed for key-shaped strings on the way in, redaction is configurable, and `mirante purge` wipes stored data. The reasoning Claude Code streams to a terminal is never stored, by anyone: it reaches the transcript with an empty field and a signature.
- **Two numbers, nothing else, from Claude Code's state file.** To show plan limits outside the terminal, Mirante reads the 5-hour and weekly figures Claude Code already caches in `~/.claude.json`. A strict schema extracts those two windows and nothing more; the account's identity in the same file is never stored, logged, or sent, and a test asserts it. Credential files are never opened. See [ADR-0007](docs/adr/0007-cached-plan-figure-refreshes-itself.md).
- **`/usage` runs only while an agent is working.** Once a minute then, and when you press "Read now"; never while idle. It spends no tokens — checked on every run, and the automatic reading stops itself if that ever changes — but Claude Code does contact Anthropic about your account when it runs. Each run removes the one transcript it leaves behind. `MIRANTE_PLAN_POLL_MS=0` turns it off. See [ADR-0007](docs/adr/0007-cached-plan-figure-refreshes-itself.md).

## Roadmap

| Milestone | Scope                                                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **M1**    | Live board: session lanes, agent cards, handoff timeline, plan usage, on-screen tool approval, SQLite persistence with replay.                                                                               |
| **M2**    | Browsable history, search, JSON export, optional OTel receiver, configurable redaction.                                                                                                                      |
| **M3**    | Fleet view across projects, stalled-wait and approaching-limit alerts, focus-the-session shortcut.                                                                                                           |
| **M4**    | Optional **driver** mode: an Agent SDK adapter that emits the same event contract, letting you send prompts, switch model and effort, and interrupt from the UI. See [docs/V2_DRIVER.md](docs/V2_DRIVER.md). |

Observer mode came first on purpose — the reasoning is recorded in [ADR-0001](docs/adr/0001-observer-before-driver.md).

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — how the daemon, sources, and projector fit together
- [docs/EVENT_MAP.md](docs/EVENT_MAP.md) — every source field mapped to a normalized event, **including where the docs and the observed behavior disagree**
- [docs/V2_DRIVER.md](docs/V2_DRIVER.md) — the driver-mode specification
- [docs/adr/](docs/adr/) — architecture decision records
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to set up, test, and send a PR

## Contributing

Contributions are welcome from the first commit. Good first issues are labeled [`good first issue`](https://github.com/christianfelipecarvalho/mirante/labels/good%20first%20issue). Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © Christian Felipe Carvalho

---

**Independent project.** Mirante is not affiliated with, endorsed by, or sponsored by Anthropic. It observes data that Claude Code already exposes on your own machine: its documented hook and status line interfaces, the transcripts it writes, and the plan-usage figure it caches in its own state file. The last two are not documented interfaces; Mirante reads them behind versioned adapters and says so in [docs/EVENT_MAP.md](docs/EVENT_MAP.md). "Claude" and "Claude Code" are trademarks of their respective owner and are used here only to describe what this tool interoperates with.
