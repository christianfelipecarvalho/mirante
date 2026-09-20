import { z } from 'zod';

/** A Claude Code settings file, read without assuming we know all of it. */
export type Settings = Record<string, unknown>;

export type HookTransport = 'http' | 'command';

export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'PreCompact',
  'PostCompact',
  'Stop',
  'StopFailure',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type InstallPlan = {
  /** Where the daemon listens. Also how Mirante's own hook entries are recognised. */
  daemonUrl: string;
  token: string;
  transport: HookTransport;
  /** Used only when transport is `command`: the shim that POSTs and exits. */
  shimPath?: string;
  statusLineWrapperPath: string;
  /** Must outlast the daemon's approval window, or the click can never win. */
  permissionTimeoutSeconds: number;
  ingestTimeoutSeconds: number;
};

export const statusLineRecordSchema = z
  .object({
    type: z.string().optional(),
    command: z.string().optional(),
    padding: z.number().optional(),
  })
  .passthrough();

/**
 * Exactly what was written, so uninstall can put it back rather than guess.
 *
 * Kept outside the settings file on purpose: a record of a change does not
 * belong in the thing it changed.
 */
export const manifestSchema = z.object({
  version: z.literal(1),
  installedAt: z.string(),
  settingsPath: z.string(),
  backupPath: z.string(),
  daemonUrl: z.string(),
  transport: z.enum(['http', 'command']),
  hookEvents: z.array(z.string()),
  statusLine: z.object({
    wrapped: z.boolean(),
    wrapperPath: z.string(),
    /** What was there before. `null` means there was no status line at all. */
    previous: statusLineRecordSchema.nullable(),
  }),
});

export type InstallManifest = z.infer<typeof manifestSchema>;
