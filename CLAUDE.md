# Mirante — repository rules

Read this before changing code. These rules exist because Mirante runs unattended, in the background, with access to prompts and tool inputs.

## Non-negotiable

1. **Never read, store, or transmit a credential.** Do not touch Claude Code credential files. No login of our own. Never call `api.anthropic.com`.
2. **No outbound network calls, ever.** See [ADR-0005](docs/adr/0005-nothing-leaves-the-machine.md). The global `fetch` is blocked by ESLint. The daemon binds `127.0.0.1` only, requires the install-time token, and validates `Origin`.
3. **User configuration is sacred.** Back up before writing. Write only inside the demarcated block. Merge idempotently without destroying existing hooks or a status line. `mirante uninstall` must reverse exactly what was written — verified by diff, not by inspection.
4. **A stopped Mirante must never degrade a Claude Code session.** Hooks and the status line wrapper fail open, fail fast, and stay silent.
5. **No raw payloads reach the front end.** Everything crosses the `MiranteEvent` boundary in `packages/shared`.

## Architecture rules

- **The UI must not know which adapter produced an event.** No `source` checks in `apps/web`, no adapter branching, no driver-only component. This is what makes M4 possible; see [ADR-0001](docs/adr/0001-observer-before-driver.md).
- **The transcript reader is pure.** No I/O inside the parser. It takes content, returns events. This is what makes it testable offline.
- **Write against fixtures, not memory.** Do not code against a schema you remember. Record a real session into `tests/fixtures/`, then write the parser against it. When observation contradicts the documentation, record the divergence in [docs/EVENT_MAP.md](docs/EVENT_MAP.md).
- **Undocumented surfaces go behind versioned adapters.** The `subagents/` directory layout is internal to Claude Code. Isolate it, detect drift, degrade gracefully.

## Design

Before writing or reshaping any UI, load the `frontend-design` and
`ui-ux-pro-max` skills and follow them. They are the design authority for this
repo.

Two constraints are specific to Mirante and override any generic advice:

- **No webfonts, no icon packages, no CDN.** Nothing may leave the machine
  ([ADR-0005](docs/adr/0005-nothing-leaves-the-machine.md)), so typography is the
  system stack and icons are drawn inline as SVG on one 24x24 grid. A glyph
  borrowed from the text font is not an icon: it carries that font's colour and
  weight, not the one the interface asked for.
- **Colour never carries meaning alone.** Every state ships an icon and a word.
  The status palette is reserved for state and never reused as decoration, and
  absent data reads as "unknown", never as zero.

## Product rule

Every waiting state must show **what** is being waited on, in short text, on the card. This is the core of the product, not a visual nicety. A state that says only "waiting" is a bug.

## Conventions

- TypeScript strict. No `any` without a comment explaining why.
- [Conventional Commits](https://www.conventionalcommits.org/). Scopes: `daemon`, `web`, `shared`, `installer`, `cli`, `docs`, `ci`.
- Tests with Vitest, against recorded fixtures. Fixtures are redacted before being committed.
- Before pushing: `pnpm check` (format, lint, typecheck, test).

## Fixtures

Fixtures come from real sessions and are **redacted before commit**. Never commit a fixture containing a real token, key, absolute home path, or private repository content. `scripts/record-fixture.ts` applies redaction; review its output by hand anyway.
