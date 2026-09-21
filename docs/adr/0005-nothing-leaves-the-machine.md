# ADR-0005 — Nothing leaves the machine

- **Status:** accepted
- **Date:** 2026-09-19

## Context

Mirante reads prompts, tool inputs, file paths, and branch names. Tool inputs routinely contain secrets: an API key pasted into a `Bash` command, a connection string in an edit. The tool is also asked to run continuously in the background, which is exactly the position from which a data leak is least likely to be noticed.

## Decision

Mirante makes **no outbound network calls**. No telemetry, no crash reporting, no update check, no account, no remote server. It never calls `api.anthropic.com`, and it never reads, stores, or forwards a credential — including Claude Code's own credential files.

This is enforced, not merely stated:

- An ESLint rule forbids the global `fetch`.
- A CI test asserts that a full ingest-and-render cycle opens no outbound socket. That test is part of M1 acceptance criterion 8.
- The daemon binds to `127.0.0.1` only, requires a token generated at install time, and validates `Origin`.

## Consequences

- No hosted mode, no sharing link, no "send us your logs" support path. Bug reports carry what the user chooses to paste.
- Redaction runs at **ingest**, before data reaches SQLite, so a purge cannot be defeated by data already written.
- `mirante purge` must fully remove stored data.
- Any future feature that needs the network — a version check, a plugin registry — requires a new ADR superseding this one, not a quiet exception.

## Amendments

- [ADR-0006](0006-plan-limits-on-demand.md) — reading plan limits through Claude Code's own local `/usage` command, on demand only. Mirante still makes no outbound call and still reads no credential; the ADR records why that is nonetheless a decision and not a detail.
- [ADR-0007](0007-cached-plan-figure-refreshes-itself.md) — while an agent is working, Mirante runs Claude Code's `/usage` once a minute. No tokens; Claude Code, not Mirante, contacts Anthropic about the account. Stops itself if `/usage` ever costs tokens.
