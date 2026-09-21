# Mirante

**Local lookout for coding agents. See every agent, what it's doing, what it's waiting on, and what it costs.**

A _mirante_ is the high point you climb to take in the whole valley at once — the overlook. That is the job of this project. When a Claude Code session starts spawning subagents, visibility collapses: you cannot see who is running, what each one is doing right now, how many tokens each has burned, who finished and handed work back to whom, and — the part that actually costs you time — what is sitting still, waiting for something.

Mirante is a local, browser-based board that answers those questions while you keep working in your terminal or in the VS Code extension.

> **Not a log feed and not a cost chart.** It is a board of cards, one per agent, each with an icon, an explicit state, its current activity, its token usage, and a timeline of handoffs between agents.

---

## Status

**Pre-release — M1 feature-complete, not yet published to npm.** Everything below works today from a clone; the `npx` route arrives with the first release. See [Run from source](#run-from-source) and the [roadmap](#roadmap).

---

## How it works

Mirante **observes**. It does not run Claude Code and it does not replace your workflow.

You keep starting sessions exactly as you do today — `claude` in a terminal, the VS Code extension, `claude -p` in a script. Mirante installs a set of hooks and a status line, reads the session transcripts Claude Code already writes to disk, and renders everything on a live board.

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

One normalized event contract, fed by:

| Source                 | Role                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Hooks**              | Primary real-time signal. Push, low latency.                                                                                                                 |
| **Transcript JSONL**   | Source of truth for content, token usage, the agent tree, when a subagent ends and why, and when a request was refused at a plan limit.                      |
| **Status line**        | Plan usage pushed while a terminal session is open.                                                                                                          |
| **`/usage`**           | Plan usage anywhere, including the VS Code extension. Run once a minute while an agent is working, and by "Read now": a local command that spends no tokens. |
| **Cached plan figure** | The 5-hour and weekly figures `/usage` leaves in `~/.claude.json`. Read for free; only those two numbers are taken.                                          |
| **OpenTelemetry**      | Optional second source for tokens and cost. Planned for M2.                                                                                                  |

Every source is normalized into the same append-only event stream before it reaches the UI. Nothing raw from a hook or a transcript is ever sent to the front end.

## Install

Two commands:

```bash
npx mirante install   # wires hooks and the status line into your Claude Code settings
npx mirante           # starts the daemon and serves the board on http://127.0.0.1:7788
```

Then open Claude Code the way you always do. The board fills itself.

To check that everything is wired up:

```bash
npx mirante doctor
```

To remove it completely:

```bash
npx mirante uninstall
```

`install` writes only inside a demarcated block, backs up every file it touches with a timestamp, merges without destroying hooks or a status line you already had, and prints exactly what changed. `uninstall` reverses precisely that block and restores your previous status line.

## Run from source

Until the first npm release, this is the way in. Requires Node 22.13+ and pnpm.

```bash
git clone https://github.com/christianfelipecarvalho/mirante.git
cd mirante
pnpm install
pnpm build

node packages/cli/dist/bin.js install   # or: pnpm mirante install
node packages/cli/dist/bin.js           # starts the daemon, prints the board URL
```

Try it against a throwaway configuration first — `MIRANTE_HOME` and `--settings` keep it
entirely out of your real setup:

```bash
MIRANTE_HOME=/tmp/mirante-try node packages/cli/dist/bin.js install \
  --settings /tmp/mirante-try/settings.json --port 7799
```

`mirante doctor` tells you whether hooks are firing, the status line is reporting, and
transcripts are being read — the three things that have to be true for the board to fill.

## Privacy and safety

These are hard rules, not defaults:

- **Mirante never reads, stores, or transmits a credential.** It does not touch Claude Code credential files, has no login of its own, and never calls `api.anthropic.com`.
- **Nothing leaves your machine.** No telemetry, no account, no remote server. There is a test in CI asserting no outbound network call is made.
- **The daemon binds to `127.0.0.1` only**, requires a token generated at install time, and validates the `Origin` header.
- **Prompts and tool inputs can contain secrets.** They are stored locally, redaction is configurable, and `mirante purge` wipes stored data.
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
