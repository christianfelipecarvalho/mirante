# ADR-0001 — Observe sessions before driving them

- **Status:** accepted
- **Date:** 2026-09-19

## Context

Mirante can learn what agents are doing in two ways: observe the sessions a person already runs, or become the thing that runs them via the Agent SDK. Both eventually ship. The question is which comes first.

## Decision

**v1 observes. Driving is deferred to M4 and is optional forever.**

## Rationale

**Adoption.** An observer is installed and then forgotten; the person keeps working exactly as before. A driver asks them to migrate their workflow into a new UI before they have any evidence the tool is worth it.

**Coverage.** An observer shows every session on the machine at once — terminal, VS Code extension, `claude -p`. A driver shows only sessions that were born inside the panel, which is precisely the sessions a person has least reason to start there on day one.

**Plan usage is observer-only.** The 5-hour and weekly limit percentages arrive through the status line, which runs only in the interactive interface. Observer mode has this data. Driver mode structurally cannot. Shipping the driver first would ship without one of the headline numbers.

**Risk.** Hooks, transcripts, and the status line are documented, stable surfaces. Building on them means less breakage per Claude Code release than binding to an SDK surface that is still moving.

## Consequences

- The normalized event contract in `packages/shared` is the seam between the phases and must be designed for both from the first commit.
- The UI is forbidden from knowing which adapter produced an event.
- One capability gap is permanent and must be surfaced in the interface: driven sessions have no plan usage. See [docs/V2_DRIVER.md](../V2_DRIVER.md).
