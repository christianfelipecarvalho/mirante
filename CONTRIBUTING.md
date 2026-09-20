# Contributing to Mirante

Thanks for being here. Contributions are welcome from the first commit.

## Setup

Requires Node 20.10+ and pnpm.

```bash
git clone https://github.com/christianfelipecarvalho/mirante.git
cd mirante
pnpm install
pnpm check      # format, lint, typecheck, test
```

## Repository layout

| Path                 | What lives there                                                 |
| -------------------- | ---------------------------------------------------------------- |
| `packages/shared`    | The event contract and the card state machine. No I/O.           |
| `packages/installer` | Settings merge, backup, status line wrapping, doctor, uninstall. |
| `packages/cli`       | The published `mirante` package and its binary.                  |
| `apps/daemon`        | Ingest, event log, projector, HTTP + WebSocket server.           |
| `apps/web`           | The React board.                                                 |

Start with [ARCHITECTURE.md](ARCHITECTURE.md), then [docs/EVENT_MAP.md](docs/EVENT_MAP.md). The [ADRs](docs/adr/) explain why things are the way they are — if a decision looks odd, the reasoning is probably recorded there.

## Working with real data

Mirante parses data produced by Claude Code. **Do not write parsers against a remembered schema.** Record a real session first:

```bash
pnpm fixture:record    # captures a session into tests/fixtures/, redacted
```

Then write the parser against the fixture. If what you observe disagrees with the official documentation, that is a finding: record it in the divergence table in [docs/EVENT_MAP.md](docs/EVENT_MAP.md) as part of your PR.

**Fixtures are redacted before commit.** Never commit a real token, key, home path, or private repository content. The recorder redacts, but review its output by hand.

## Rules that will block a PR

These come from [CLAUDE.md](CLAUDE.md) and are not style preferences:

- Any outbound network call. See [ADR-0005](docs/adr/0005-nothing-leaves-the-machine.md).
- Reading or storing credentials.
- Modifying user settings outside the demarcated block, or without a backup.
- Raw hook or transcript fields reaching `apps/web`.
- `apps/web` branching on which adapter produced an event.
- A waiting state that does not say what it is waiting on.

## Commits and PRs

[Conventional Commits](https://www.conventionalcommits.org/), with scopes `daemon`, `web`, `shared`, `installer`, `cli`, `docs`, `ci`:

```
feat(daemon): route subagent events by agent_id
fix(installer): preserve existing statusLine padding on wrap
docs(event-map): record async subagent divergence
```

Before opening a PR: run `pnpm check`, add a test for behavior you changed, and update `docs/EVENT_MAP.md` if you touched parsing.

CI runs format, lint, typecheck, and tests on Node 20 and 22.

## Good first issues

Issues labeled [`good first issue`](https://github.com/christianfelipecarvalho/mirante/labels/good%20first%20issue) are scoped to be completable without deep context. Agent icon mapping, `doctor` checks, and status line edge cases are usually good entry points.

## Questions

Open a [discussion](https://github.com/christianfelipecarvalho/mirante/discussions) or an issue. Reporting that Mirante broke against a new Claude Code version is a genuinely valuable contribution — include your `claude --version` and the output of `mirante doctor`.
