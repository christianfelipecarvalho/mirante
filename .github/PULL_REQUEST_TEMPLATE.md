## What this changes

<!-- One or two sentences. What behavior is different after this PR? -->

## Why

<!-- Link the issue, or explain the problem. -->

Closes #

## How it was verified

<!-- Which fixture, which test, or which manual steps. "It builds" is not verification. -->

## Checklist

- [ ] `pnpm check` passes (format, lint, typecheck, test)
- [ ] A test covers the changed behavior
- [ ] If parsing changed: `docs/EVENT_MAP.md` is updated, including any new divergence between the docs and observed behavior
- [ ] If a fixture was added: it is redacted — no tokens, keys, home paths, or private repository content
- [ ] No outbound network call was introduced ([ADR-0005](../docs/adr/0005-nothing-leaves-the-machine.md))
- [ ] No raw hook or transcript field reaches `apps/web`
- [ ] If a waiting state was added: the card says **what** is being waited on
