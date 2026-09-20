# ADR-0003 — Prefer HTTP hooks over command hooks

- **Status:** accepted
- **Date:** 2026-09-19

## Context

Claude Code hooks support several transports. Mirante receives a high-frequency stream — every tool call fires at least two hooks. A `command` hook pays a process spawn on each one.

## Decision

Register `type: "http"` hooks pointing at the daemon on `127.0.0.1`, authenticated with a bearer token. Fall back to `type: "command"` with a minimal POST shim only when the installed Claude Code version does not support HTTP hooks.

Verified present in **2.1.272**, with fields `url`, `headers`, `allowedEnvVars`, `timeout`, `statusMessage`.

## Notes

- `allowedEnvVars` must list the token variable, or `$MIRANTE_TOKEN` will not expand inside `headers`.
- Mirante always sets an explicit, short `timeout`. The 600 s default is unusable for a tool that gates permission prompts.
- The installer detects support at install time and records which transport it chose, so `doctor` and `uninstall` know what was written.

## Consequences

- No process spawn per event.
- The daemon must be running for hooks to land. A hook that cannot reach it must fail open and silently: a stopped Mirante must never degrade a Claude Code session.
- Two transports must be kept working, which is a maintenance cost accepted for compatibility with older versions.
